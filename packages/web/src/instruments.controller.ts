import { Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import { TestMapping, type VerificationStatus } from '@lis/contracts';
import type { Db } from '@lis/db';
import { clinicalGateFor } from '@lis/domain';
import {
  approveAndActivateMappings, changeInstrumentRegistration, InvalidInput, loadInstrument, MAPPING_FILE_EXAMPLE, recordInstrumentEvidence,
  registerInstrumentRecord, saveMappingDraft, setInstrumentEnabled,
} from '@lis/lab';
import type { Response } from 'express';
import { confirmPassword } from './auth.js';
import { page, str, type Form } from './controllers.js';
import { formatTime } from './format.js';
import { formOptions, formToRegistration, GENERIC_ASTM_EXAMPLE, GENERIC_HL7_EXAMPLE, pickForm, registrationToForm, type InstrumentForm } from './instrument-form.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

const ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
function idParam(id: string): string {
  if (!ID.test(id)) throw new NotFoundException();
  return id;
}

/** Date from an <input type="date">, as the start of that day in UTC. */
const dateToIso = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : d);

@Controller('instruments')
export class InstrumentsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private form(req: WebRequest, res: Response, view: 'instrument-new' | 'instrument-edit', f: InstrumentForm, extra: Record<string, unknown> = {}): void {
    page(req, res, view, {
      title: view === 'instrument-new' ? 'Register instrument' : `Change ${f['instrumentId']}`,
      f,
      ...formOptions(f),
      astmExample: GENERIC_ASTM_EXAMPLE,
      hl7Example: GENERIC_HL7_EXAMPLE,
      noQcChecked: f['noQcConfirmed'] === 'yes',
      ...extra,
    });
  }

  private async stepUp(req: WebRequest, body: Form): Promise<void> {
    if (!(await confirmPassword(this.db, req.user!.id, str(body, 'password')))) throw new ForbiddenException('Password not confirmed. Nothing was changed.');
  }

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    const rows = await this.db.instrument.findMany({ orderBy: { displayName: 'asc' } });
    page(req, res, 'instruments', {
      title: 'Instruments',
      rows: rows.map((i) => ({
        id: i.id,
        href: `/instruments/${i.id}`,
        name: i.displayName,
        model: `${i.manufacturer} ${i.model}`,
        software: i.softwareVersion ?? '',
        verification: i.verificationStatus.replace('_', ' ').toLowerCase(),
        enabled: i.enabled,
      })),
    });
  }

  @Get('new')
  @Roles('admin', 'technologist')
  newForm(@Req() req: WebRequest, @Res() res: Response): void {
    this.form(req, res, 'instrument-new', pickForm({ transportType: 'tcp-client', discipline: 'other' }));
  }

  @Post()
  @Roles('admin', 'technologist')
  async register(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const f = pickForm(body);
    const built = formToRegistration(f);
    try {
      if (!built.ok) throw new InvalidInput(built.issues);
      const id = await registerInstrumentRecord(this.db, built.value, req.user!.username);
      res.redirect(303, `/instruments/${id}?notice=registered`);
    } catch (e) {
      if (!(e instanceof InvalidInput)) throw e;
      res.status(422);
      this.form(req, res, 'instrument-new', f, { issues: e.issues });
    }
  }

  @Get(':id')
  async detail(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const i = await this.db.instrument.findUnique({
      where: { id: idParam(id) },
      include: { evidence: { orderBy: { recordedAt: 'asc' } }, mappingSets: { orderBy: { versionNo: 'desc' } }, connections: { orderBy: { activeFrom: 'desc' } }, lease: true },
    });
    if (!i) throw new NotFoundException();
    const gate = clinicalGateFor({
      enabled: i.enabled,
      verificationStatus: i.verificationStatus.toLowerCase() as VerificationStatus,
      softwareVersion: i.softwareVersion,
      verifiedSoftwareVersion: i.verifiedSoftwareVersion,
    });
    const active = i.mappingSets.find((m) => m.status === 'ACTIVE');
    const draft = i.mappingSets.find((m) => m.status === 'DRAFT');
    const mappingsOf = (m: typeof active) => (m ? TestMapping.array().safeParse(m.mappingsJson).data ?? [] : []);
    const conn = i.connections.find((c) => !c.activeTo);
    const status = i.verificationStatus;
    page(req, res, 'instrument', {
      title: i.displayName,
      i: {
        id: i.id,
        name: i.displayName,
        manufacturer: i.manufacturer,
        model: i.model,
        serialNo: i.serialNo ?? '',
        softwareVersion: i.softwareVersion ?? '',
        verifiedSoftwareVersion: i.verifiedSoftwareVersion ?? '',
        discipline: i.discipline,
        location: i.location ?? '',
        manual: i.interfaceManualRef ?? '',
        verification: status.replace('_', ' ').toLowerCase(),
        enabled: i.enabled,
        version: i.version,
        linked: !!i.lease && i.lease.leaseUntil > new Date(),
      },
      clinical: gate.releasable,
      gateDetail: gate.releasable ? '' : gate.detail,
      connection: conn ? JSON.stringify(conn.configJson, null, 2) : '',
      connectionSince: conn ? formatTime(conn.activeFrom) : '',
      evidence: i.evidence.map((e) => ({ kind: e.kind, from: e.fromStatus.toLowerCase(), to: e.toStatus.toLowerCase(), by: e.recordedBy, at: formatTime(e.recordedAt), detail: JSON.stringify(e.evidenceJson) })),
      next: {
        interfaceTest: status === 'UNVERIFIED',
        labAcceptance: status === 'VENDOR_TESTED',
        suspend: status !== 'SUSPENDED',
        reverify: status === 'SUSPENDED',
        enable: !i.enabled && status !== 'SUSPENDED',
        disable: i.enabled,
      },
      today: new Date().toISOString().slice(0, 10),
      active: active ? { versionNo: active.versionNo, by: active.createdBy, approvedBy: active.approvedBy, at: formatTime(active.activeFrom), mappings: mappingsOf(active) } : null,
      draft: draft ? { versionNo: draft.versionNo, by: draft.createdBy, mappings: mappingsOf(draft), mine: draft.createdBy === req.user?.username } : null,
      mappingText: JSON.stringify(draft ? draft.mappingsJson : active ? active.mappingsJson : MAPPING_FILE_EXAMPLE, null, 2),
      history: i.mappingSets.map((m) => ({ versionNo: m.versionNo, status: m.status.toLowerCase(), by: m.createdBy, approvedBy: m.approvedBy ?? '' })),
    });
  }

  @Get(':id/edit')
  @Roles('admin', 'technologist')
  async editForm(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const loaded = await loadInstrument(this.db, idParam(id));
    this.form(req, res, 'instrument-edit', registrationToForm(loaded.state.registration), { rowVersion: loaded.rowVersion, status: loaded.state.verificationStatus.replace('_', ' ') });
  }

  @Post(':id/edit')
  @Roles('admin', 'technologist')
  async edit(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const f = { ...pickForm(body), instrumentId: idParam(id) };
    const built = formToRegistration(f);
    try {
      if (!built.ok) throw new InvalidInput(built.issues);
      const r = await changeInstrumentRegistration(this.db, id, built.value, Number(str(body, 'rowVersion')), req.user!.username);
      res.redirect(303, `/instruments/${id}?notice=${r.resetReasons.length ? 'reset' : r.retestReasons.length ? 'retest' : 'changed'}`);
    } catch (e) {
      if (!(e instanceof InvalidInput)) throw e;
      res.status(422);
      this.form(req, res, 'instrument-edit', f, { issues: e.issues, rowVersion: str(body, 'rowVersion') });
    }
  }

  /** Verification evidence (14 §3 rule 3). Lab acceptance is signed by the signed-in approver, with their password. */
  @Post(':id/evidence')
  @Roles('admin', 'approver')
  async evidence(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const kind = str(body, 'kind');
    const user = req.user!;
    let evidence: Record<string, unknown>;
    if (kind === 'interface-test') {
      evidence = { kind, testedBy: str(body, 'testedBy').trim(), organisation: str(body, 'organisation').trim(), testedAt: dateToIso(str(body, 'testedAt')), recordRef: str(body, 'recordRef').trim(), softwareVersion: str(body, 'softwareVersion').trim() };
    } else if (kind === 'lab-acceptance') {
      if (!user.roles.includes('approver')) throw new ForbiddenException('Lab acceptance is signed by an approver (lab director).');
      await this.stepUp(req, body);
      evidence = { kind, signedBy: user.username, signedAt: new Date().toISOString(), acceptanceRef: str(body, 'acceptanceRef').trim() };
    } else {
      evidence = { kind, reason: str(body, 'reason').trim() };
    }
    await recordInstrumentEvidence(this.db, idParam(id), evidence, user.username);
    res.redirect(303, `/instruments/${id}?notice=evidence`);
  }

  @Post(':id/enabled')
  @Roles('admin', 'approver')
  async enabled(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const on = str(body, 'enabled') === 'true';
    if (on && !req.user!.roles.includes('approver')) throw new ForbiddenException('Turning an instrument on is done by an approver (lab director).');
    await setInstrumentEnabled(this.db, idParam(id), on, req.user!.username, str(body, 'reason'));
    res.redirect(303, `/instruments/${id}?notice=${on ? 'enabled' : 'disabled'}`);
  }

  /** Save the reviewed mapping file as the draft (13 phase 2: mappings loaded from a reviewed file). */
  @Post(':id/mappings')
  @Roles('admin', 'technologist')
  async saveDraft(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    let mappings: unknown;
    try {
      mappings = JSON.parse(str(body, 'mappings'));
    } catch {
      throw new InvalidInput(['mappings: not valid JSON']);
    }
    await saveMappingDraft(this.db, idParam(id), mappings, req.user!.username);
    res.redirect(303, `/instruments/${id}?notice=draft#mappings`);
  }

  @Post(':id/mappings/:version/approve')
  @Roles('approver')
  async approveDraft(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Param('version') version: string, @Body() body: Form): Promise<void> {
    await this.stepUp(req, body);
    await approveAndActivateMappings(this.db, idParam(id), Number(version), req.user!.username);
    res.redirect(303, `/instruments/${id}?notice=activated#mappings`);
  }
}
