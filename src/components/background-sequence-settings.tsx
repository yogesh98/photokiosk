"use client";
/* eslint-disable @next/next/no-img-element */
import { useId, useState } from "react";
import { Check, Images } from "lucide-react";
import { resolveSessionBackgrounds } from "@/lib/background-sequence";
import type { Background, KioskSettings } from "@/lib/kiosk-types";
import type { SaveSettings } from "./studio-shared";

const SEQUENCE_OPTIONS = [
  {
    value: "single",
    label: "Same background",
    detail: "Use the active background for all three photos.",
  },
  {
    value: "rotate",
    label: "Rotate backgrounds",
    detail: "Start with the active scene, then use the next two.",
  },
  {
    value: "custom",
    label: "Choose per photo",
    detail: "Pick a background for each of the three photos.",
  },
] as const;

export function BackgroundSequenceSettings({
  settings,
  backgrounds,
  busy,
  onSave,
}: {
  settings: KioskSettings;
  backgrounds: Background[];
  busy: boolean;
  onSave: SaveSettings;
}) {
  const [sequence, setSequence] = useState(settings.backgroundSequence);
  const groupId = useId();
  const replacementOff = settings.backgroundMode === "off";
  const scenes = resolveSessionBackgrounds(
    { ...settings, backgroundSequence: sequence },
    backgrounds,
  );
  const changed = JSON.stringify(sequence) !== JSON.stringify(settings.backgroundSequence);
  const unavailable = replacementOff || backgrounds.length === 0;

  return (
    <section className="panel background-sequence-panel" aria-labelledby={`${groupId}-title`}>
      <div className="section-heading">
        <div>
          <h2 id={`${groupId}-title`}><Images size={19} />Backgrounds for each photo</h2>
          <p>Plan the scenes for each three-photo session.</p>
        </div>
      </div>
      <fieldset
        className="background-mode-field"
        disabled={busy || unavailable}
        aria-describedby={`${groupId}-help`}
      >
        <legend>During each session</legend>
        <div className="background-mode-options">
          {SEQUENCE_OPTIONS.map((option) => (
            <label className="background-mode-option" key={option.value}>
              <input
                type="radio"
                name={groupId}
                value={option.value}
                checked={sequence.mode === option.value}
                onChange={() => setSequence({ ...sequence, mode: option.value })}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
            </label>
          ))}
        </div>
        <p className="background-mode-help" id={`${groupId}-help`} aria-live="polite">
          {replacementOff
            ? "Background replacement is off. All three photos keep the camera’s original scene. Enable Green screen or AI below to use these backgrounds."
            : backgrounds.length === 0
              ? "Upload a background to set the scenes for your photos."
              : sequence.mode === "rotate"
                ? "Follow the library order below, returning to the first background when you reach the end. Each session starts with your active background."
                : sequence.mode === "custom"
                  ? "Choose any combination, including the same background more than once. The preview switches scenes before each photo."
                  : "Choose the active background from the library below. All three photos use that scene."}
        </p>
        <div className="background-sequence-grid">
          {scenes.map((scene, index) => (
            <div className="background-sequence-card" key={index}>
              <div className="background-sequence-image">
                {scene ? <img src={scene.url} alt="" /> : <Images size={28} aria-hidden="true" />}
                <span>Photo {index + 1}</span>
              </div>
              {sequence.mode === "custom" && !unavailable ? (
                <label className="field background-sequence-choice">
                  <span>Photo {index + 1} background</span>
                  <select
                    value={sequence.photoIds[index]}
                    onChange={(event) => {
                      const photoIds: KioskSettings["backgroundSequence"]["photoIds"] = [...sequence.photoIds];
                      photoIds[index] = event.target.value;
                      setSequence({ ...sequence, photoIds });
                    }}
                  >
                    {backgrounds.map((background) => (
                      <option value={background.id} key={background.id}>{background.name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="background-sequence-name">{scene?.name ?? "Original camera scene"}</p>
              )}
            </div>
          ))}
        </div>
      </fieldset>
      <div className="panel-footer">
        <span className="field-hint">{changed ? "Save to apply this plan to the next session." : "Saved plan for the next session."}</span>
        <div>
          <button
            className="button dark small"
            disabled={busy || unavailable || !changed}
            onClick={() => onSave({ backgroundSequence: sequence }, "Photo backgrounds saved.")}
          >
            Save photo backgrounds<Check size={14} />
          </button>
        </div>
      </div>
    </section>
  );
}
