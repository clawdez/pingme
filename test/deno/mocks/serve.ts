// Stand-in for std/http `serve`: capture the handler instead of listening.
export function serve(handler: (req: Request) => Response | Promise<Response>) {
  (globalThis as any).__handler = handler;
}
