// Headless scripts reach a world only signed in: the app opens on the sign-in
// screen (app/App.ts). One fixed bench account, registered on first use against
// whichever api the client proxies to; BENCH_USER / BENCH_PASSWORD override it.

const account = {
  username: process.env.BENCH_USER ?? "bench",
  password: process.env.BENCH_PASSWORD ?? "bench-password",
};

/** Sign `context` in through the client at `base`. Its pages then carry the session cookie. */
export async function signIn(context, base) {
  // The context's request client shares the context's cookies, so the session lands where the pages read it.
  const registered = await context.request.post(`${base}/api/auth/register`, { data: account, failOnStatusCode: false });
  if (registered.ok()) {
    return;
  }
  if (registered.status() !== 409) {
    throw new Error(`register ${account.username}: ${registered.status()} ${await registered.text()} — is the api running?`);
  }
  const loggedIn = await context.request.post(`${base}/api/auth/login`, { data: account, failOnStatusCode: false });
  if (!loggedIn.ok()) {
    throw new Error(`sign in as ${account.username}: ${loggedIn.status()} ${await loggedIn.text()}`);
  }
}
