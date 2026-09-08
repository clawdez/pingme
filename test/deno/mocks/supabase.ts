// In-memory stand-in for the slice of supabase-js that send-email uses:
// PostgREST-style query builder over plain arrays, auth.getUser keyed by the
// bearer token, and the admin API (createUser / updateUserById / generateLink).
// Mirrors the live constraints that matter: email_otps.user_id must reference
// an existing auth user (FK) and is unique per user; auth emails are unique.
type Row = Record<string, any>;
export interface Db {
  tables: Record<string, Row[]>;
  users: Row[];
  tokens: Record<string, Row>;
  log: any[];
  resendFail: boolean;
}
export const db: Db = ((globalThis as any).__db ??= {
  tables: { email_otps: [], profiles: [], pings: [] }, users: [], tokens: {}, log: [], resendFail: false,
});
export function resetDb() {
  db.tables = { email_otps: [], profiles: [], pings: [] };
  db.users = []; db.tokens = {}; db.log = []; db.resendFail = false;
}

class Query {
  private op = 'select';
  private payload: any = null;
  private opts: any = null;
  private filters: Array<(r: Row) => boolean> = [];
  private wantSingle = false;
  constructor(private table: string) {}
  select() { return this; }
  insert(row: Row) { this.op = 'insert'; this.payload = row; return this; }
  upsert(row: Row, opts?: any) { this.op = 'upsert'; this.payload = row; this.opts = opts; return this; }
  update(patch: Row) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(k: string, v: any) { this.filters.push((r) => r[k] === v); return this; }
  gt(k: string, v: any) { this.filters.push((r) => r[k] > v); return this; }
  single() { this.wantSingle = true; return this; }
  then(res: any, rej: any) { return Promise.resolve().then(() => this.run()).then(res, rej); }
  private run() {
    const rows = (db.tables[this.table] ??= []);
    const match = rows.filter((r) => this.filters.every((f) => f(r)));
    db.log.push({ table: this.table, op: this.op, payload: this.payload, n: match.length });
    if (this.op === 'select') {
      if (this.wantSingle) {
        return match.length === 1 ? { data: match[0], error: null }
          : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      }
      return { data: match, error: null };
    }
    if (this.op === 'insert' || this.op === 'upsert') {
      const row = { ...this.payload };
      if (this.table === 'email_otps' && !db.users.some((u) => u.id === row.user_id)) {
        return { data: null, error: { code: '23503', message: 'insert or update on table "email_otps" violates foreign key constraint' } };
      }
      const key = this.op === 'upsert' ? (this.opts?.onConflict || 'id') : null;
      const i = key ? rows.findIndex((r) => r[key] === row[key]) : -1;
      if (i >= 0) rows[i] = { ...rows[i], ...row };
      else {
        if (this.table === 'email_otps' && rows.some((r) => r.user_id === row.user_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
        rows.push({ id: crypto.randomUUID(), ...row });
      }
      return { data: null, error: null };
    }
    if (this.op === 'update') { for (const r of match) Object.assign(r, this.payload); return { data: match, error: null }; }
    if (this.op === 'delete') { db.tables[this.table] = rows.filter((r) => !match.includes(r)); return { data: null, error: null }; }
    return { data: null, error: { message: 'unsupported op ' + this.op } };
  }
}

export function createClient(_url: string, _key: string, opts?: any) {
  const bearer = String(opts?.global?.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
  return {
    from: (table: string) => new Query(table),
    auth: {
      getUser: async () => {
        const u = db.tokens[bearer];
        return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'invalid claim: missing sub claim' } };
      },
      admin: {
        createUser: async (attrs: Row) => {
          db.log.push({ admin: 'createUser', attrs });
          if (attrs.email && db.users.some((u) => u.email === attrs.email)) {
            return { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
          }
          const u = { id: crypto.randomUUID(), email: attrs.email ?? null, email_confirmed_at: attrs.email_confirm ? new Date().toISOString() : null,
            is_anonymous: !attrs.email, created_at: new Date().toISOString() };
          db.users.push(u);
          return { data: { user: u }, error: null };
        },
        updateUserById: async (id: string, attrs: Row) => {
          db.log.push({ admin: 'updateUserById', id, attrs });
          const u = db.users.find((x) => x.id === id);
          if (!u) return { data: { user: null }, error: { message: 'User not found' } };
          if (attrs.email && db.users.some((o) => o.id !== id && o.email === attrs.email)) {
            return { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
          }
          if (attrs.email) u.email = attrs.email;
          if (attrs.email_confirm && !u.email_confirmed_at) u.email_confirmed_at = new Date().toISOString();
          return { data: { user: u }, error: null };
        },
        generateLink: async (attrs: Row) => {
          db.log.push({ admin: 'generateLink', attrs });
          const u = db.users.find((x) => x.email === attrs.email);
          if (!u) return { data: null, error: { message: 'User not found' } };
          return { data: { properties: { hashed_token: 'hash-' + attrs.type + '-' + u.id, action_link: 'https://x/verify' } }, error: null };
        },
      },
    },
  };
}
