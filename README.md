# LIS Middleware JS

On-premises laboratory middleware that connects a hospital HMIS API to
laboratory analyzers (initially Roche cobas e 411, Roche cobas c 111 and
Mindray haematology analyzers; further instruments once the lab's full
inventory is known).

**Status: phase 1 (protocol cores).** Protocol codecs, the e 411 and Mindray adapters, generic result-only adapters, and instrument registration rules exist (the c 111 adapter is designed, not yet built); no transport, database or UI yet, and no
instrument compatibility is claimed until the installed instruments pass
interface testing. Start with [`docs/README.md`](docs/README.md).

## Development

Requires Node.js 22.12 or newer (see `.nvmrc`).

```sh
npm ci            # install from the lockfile
npm run check     # typecheck, test, build
```

### Packages

| Package | Purpose |
|---|---|
| `@lis/contracts` | Zod schemas shared by all processes: identifiers, clinical values, normalised analyzer messages, connection config |
| `@lis/domain` | Pure domain logic: clinical value parser (decimals kept as strings), instrument verification lifecycle, versioned test mappings |
| `@lis/protocol-astm` | ASTM E1381 frame codec, checksum, host-side link state machine, E1394 record parser. No I/O. |
| `@lis/protocol-hl7v2` | MLLP codec, HL7 v2 parser/encoder. No I/O. |
| `@lis/adapter-cobas-e411` | cobas e 411 query/result parsing (cobas® and Elecsys® dialects) and query reply builder |
| `@lis/adapter-mindray-hl7` | Mindray ORU/ORM parsing, ACK^R01 and ORR^O02 builders |
| `@lis/adapter-generic` | Result-only ASTM and HL7/MLLP adapters driven by an administrator's profile, for instruments without a model-specific driver |

The adapters are written against the vendor manuals listed in
[`docs/README.md`](docs/README.md) and are **unverified** against the installed
instruments. They must not be used clinically before interface verification.
