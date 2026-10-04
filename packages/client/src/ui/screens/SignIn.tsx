import { useEffect, useRef, useState } from "preact/hooks";
import { useUi } from "../context.js";
import { MenuScreen } from "../menu/Menu.js";
import { MenuArt } from "./MenuArt.js";
import styles from "./SignIn.module.css";

/**
 * The first screen. Multiplayer needs a player the api knows, so signing in
 * comes before the menu — and one form does both jobs, because registering and
 * signing in ask for exactly the same two things.
 */
export function SignIn() {
  const { state, commands } = useUi();
  const [registering, setRegistering] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const busy = state.authBusy.value;
  const ready = username.length > 0 && password.length > 0 && !busy;

  const submit = (e: Event) => {
    e.preventDefault();
    if (!ready) {
      return;
    }
    (registering ? commands.register : commands.signIn)(username, password);
  };

  return (
    <MenuScreen class={styles.screen}>
      <MenuArt />
      <div class={styles.panel}>
        <h1 class={styles.title}>{registering ? "Create Account" : "Sign In"}</h1>
        <form class={styles.form} onSubmit={submit}>
          <label class={styles.field}>
            <span>Username</span>
            <input ref={first} class={styles.input} value={username} autocomplete="username" onInput={(e) => setUsername(e.currentTarget.value)} />
          </label>
          <label class={styles.field}>
            <span>Password</span>
            <input
              class={styles.input}
              type="password"
              value={password}
              autocomplete={registering ? "new-password" : "current-password"}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
          </label>

          {/* Only when there is one: an always-present empty alert is both a
              dead gap in the form and a thing a screen reader has to skip. */}
          {state.authError.value && (
            <p class={styles.error} role="alert">
              {state.authError.value}
            </p>
          )}

          <button class={styles.submit} type="submit" disabled={!ready}>
            {busy ? "…" : registering ? "Create Account" : "Sign In"}
          </button>
        </form>

        <button
          class={styles.toggle}
          type="button"
          onClick={() => {
            setRegistering(!registering);
            state.authError.value = null;
          }}
        >
          {registering ? "I already have an account" : "Create an account"}
        </button>
      </div>
    </MenuScreen>
  );
}
