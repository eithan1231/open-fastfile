import { useState } from "preact/hooks";
import { AUDIO_CHANNEL_CHOICES, AUDIO_CHANNEL_LABELS, QUALITY_CHOICES, SENSITIVITY_LIMITS, type AudioChannel } from "../../app/uiBridge.js";
import { useUi } from "../context.js";
import { MenuColumn, type MenuItem, MenuPanel, MenuScreen, useEscape } from "../menu/Menu.js";
import { PauseMap } from "./PauseMap.js";
import styles from "./PauseMenu.module.css";

type Panel = "options" | "audio" | "controls";

/** Shown over a paused world, which it blurs. Esc or Resume Game leaves it; a click elsewhere does nothing. */
export function PauseMenu() {
  const { state, commands } = useUi();
  const [panel, setPanel] = useState<Panel | null>(null);
  useEscape(panel ? () => setPanel(null) : undefined);
  const toggle = (p: Panel) => () => setPanel(panel === p ? null : p);
  const lobby = state.lobby.value;
  const items: MenuItem[] = [
    { label: "Resume Game", onSelect: () => commands.resume() },
    // Only in a match that lets players choose, once they are in it.
    ...(state.canChooseClass.value ? [{ label: "Choose Class", onSelect: () => commands.openClassChoice() }] : []),
    { label: "Options", onSelect: toggle("options"), open: panel === "options" },
    { label: "Audio", onSelect: toggle("audio"), open: panel === "audio" },
    { label: "Controls", onSelect: toggle("controls"), open: panel === "controls" },
    // A private match's host ends it for everyone, back to the lobby, which is
    // how its map is changed. Leave Game takes only this player out.
    ...(lobby?.private && lobby.host && lobby.playing ? [{ label: "End Match", onSelect: () => commands.endLobby() }] : []),
    { label: "Leave Game", onSelect: () => commands.returnToMenu() },
  ];
  return (
    <MenuScreen class={styles.screen} role="dialog" aria-label="Paused">
      <MenuColumn title="Paused" items={items}>
        <PauseMap />
      </MenuColumn>
      {panel === "options" ? (
        <Options />
      ) : panel === "audio" ? (
        <Audio />
      ) : panel === "controls" ? (
        <Controls />
      ) : (
        <MenuPanel title={state.worldName.value ?? "Paused"} />
      )}
    </MenuScreen>
  );
}

function Options() {
  const { state, commands } = useUi();
  const quality = state.quality.value;
  return (
    <MenuPanel title="Options">
      <div class={styles.block}>
        <h3 class={styles.heading}>Quality</h3>
        <div class={styles.segmented} role="radiogroup" aria-label="Quality">
          {QUALITY_CHOICES.map((level) => (
            <button key={level} role="radio" aria-checked={level === quality} class={styles.choice} onClick={() => commands.setQuality(level)}>
              {level}
            </button>
          ))}
        </div>
      </div>
      <div class={styles.block}>
        <h3 class={styles.heading}>Mouse sensitivity</h3>
        <label class={styles.slider}>
          <input
            type="range"
            min={SENSITIVITY_LIMITS.min}
            max={SENSITIVITY_LIMITS.max}
            step={SENSITIVITY_LIMITS.step}
            value={state.sensitivity.value}
            onInput={(e) => commands.setSensitivity(e.currentTarget.valueAsNumber)}
          />
          <output>{state.sensitivity.value.toFixed(1)}</output>
        </label>
      </div>
    </MenuPanel>
  );
}

/** Master, the mute, and one slider per mixer channel. Every change is applied at once and remembered per browser. */
function Audio() {
  const { state, commands } = useUi();
  const audio = state.audio.value;
  const slider = (label: string, value: number, onChange: (v: number) => void) => (
    <div class={styles.block} key={label}>
      <h3 class={styles.heading}>{label}</h3>
      <label class={styles.slider}>
        <input type="range" min={0} max={1} step={0.01} value={value} onInput={(e) => onChange(e.currentTarget.valueAsNumber)} aria-label={label} />
        <output>{Math.round(value * 100)}</output>
      </label>
    </div>
  );
  return (
    <MenuPanel title="Audio">
      {slider("Master", audio.master, (v) => commands.setAudioVolume("master", v))}
      <div class={styles.block}>
        <h3 class={styles.heading}>Mute</h3>
        <div class={styles.segmented} role="radiogroup" aria-label="Mute">
          {[false, true].map((muted) => (
            <button key={String(muted)} role="radio" aria-checked={audio.muted === muted} class={styles.choice} onClick={() => commands.setAudioMuted(muted)}>
              {muted ? "muted" : "on"}
            </button>
          ))}
        </div>
      </div>
      {AUDIO_CHANNEL_CHOICES.map((channel: AudioChannel) =>
        slider(AUDIO_CHANNEL_LABELS[channel], audio.channels[channel], (v) => commands.setAudioVolume(channel, v)),
      )}
    </MenuPanel>
  );
}

function Controls() {
  const { state } = useUi();
  const showDev = state.debug.enabled.value;
  const controls = state.controls.value.filter((c) => showDev || !c.dev);
  return (
    <MenuPanel title="Controls">
      <dl class={styles.controls}>
        {controls.map((c) => (
          <div key={c.label}>
            <dt>{c.label}</dt>
            <dd>{c.keys}</dd>
          </div>
        ))}
      </dl>
    </MenuPanel>
  );
}
