import { useState } from "preact/hooks";
import { useUi } from "../context.js";
import { MenuScreen } from "../menu/Menu.js";
import styles from "./Loading.module.css";

/** The world's picture behind a dark left side, what it is at the top, and the load's progress at the bottom. */
export function Loading() {
  const loading = useUi().state.loading.value;
  const world = loading?.world;
  return (
    <MenuScreen class={styles.screen} role="status">
      {world?.thumbnail && <Picture src={world.thumbnail} />}
      <div class={styles.shade} />
      <header class={styles.about}>
        <h1 class={styles.name}>{world?.name ?? "Loading"}</h1>
        {world?.category && <p class={styles.category}>{world.category}</p>}
        {world?.description && <p class={styles.description}>{world.description}</p>}
      </header>
      <footer class={styles.progress}>
        <div class={styles.label}>
          <span>Loading</span>
          {loading && <span class={styles.step}>{loading.step}</span>}
        </div>
        <div class={styles.track}>
          <div class={styles.bar} style={{ width: `${(loading?.progress ?? 0) * 100}%` }} />
        </div>
      </footer>
    </MenuScreen>
  );
}

/** Fades in once loaded, rather than painting top to bottom. */
function Picture({ src }: { src: string }) {
  const [loaded, setLoaded] = useState(false);
  return <img class={loaded ? styles.pictureLoaded : styles.picture} src={src} alt="" onLoad={() => setLoaded(true)} />;
}
