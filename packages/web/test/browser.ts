export const PW = 'a long test password';

/** A browser stand-in: keeps cookies, does not follow redirects. */
export class Browser {
  cookies = new Map<string, string>();
  constructor(private readonly base: string) {}

  async request(method: string, path: string, form?: Record<string, string>): Promise<{ status: number; location: string | null; html: string; headers: Headers }> {
    const res = await fetch(this.base + path, {
      method,
      redirect: 'manual',
      headers: {
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, ...v] = (pair as string).split('=');
      const value = v.join('=');
      if (value === '' || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k as string);
      else this.cookies.set(k as string, value);
    }
    return { status: res.status, location: res.headers.get('location'), html: await res.text(), headers: res.headers };
  }
  get = (path: string) => this.request('GET', path);
  post = (path: string, form: Record<string, string>) => this.request('POST', path, form);

  /** The session CSRF token, read from any signed-in page. */
  async csrf(path = '/'): Promise<string> {
    const { html } = await this.get(path);
    const m = /name="_csrf" value="([0-9a-f]{64})"/.exec(html);
    if (!m) throw new Error(`no CSRF token on ${path}`);
    return m[1] as string;
  }

  async signIn(username: string, password = PW): Promise<{ status: number; location: string | null; html: string }> {
    const { html } = await this.get('/login');
    const token = /name="_csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? '';
    return this.post('/login', { _csrf: token, username, password, next: '/' });
  }
}
