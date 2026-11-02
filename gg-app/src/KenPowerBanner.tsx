// "Ken is on." / "Ken is off." notice shown over the chat BODY (inside
// `.transcript-frame`, a non-scrolling sibling of `.transcript` sized to the
// same viewport — NOT inside `.transcript` itself, which scrolls, so an
// absolutely positioned overlay there would pin to the scrolled content
// instead of what's on screen) when Autopilot (Ken's auto-review loop) is
// toggled — the chat head/nav and footer stay visible around it. Plain single
// line styled exactly like the wake screen's, so both states render identically
// and only the words differ.
// Pops in with the same scale+fade "flash" the app uses for its zoom-level HUD,
// holds briefly, then dissolves back out — quick, decorative, non-interactive,
// no lateral motion. Self-removes via `onDone` once the animation finishes so
// the caller can just stop rendering it. Ken's pixel face leads the line and
// acts it out: he wakes up for "on" and nods off for "off".
import { MENTOR_NAME } from "./brand";
import { KenFace } from "./KenFace";

interface Props {
  mode: "on" | "off";
  /** Fired once the flash animation finishes — unmount it here. */
  onDone: () => void;
}

export function KenPowerBanner({ mode, onDone }: Props): React.ReactElement {
  return (
    <div className="ken-power-overlay" aria-hidden="true">
      {/* Keyed on `mode` so flipping the toggle again mid-animation remounts
          this node instead of restyling it in place — the flash always plays
          from a clean start, even on a rapid on/off/on flip. */}
      {/* The face animates inside the banner and animationend bubbles, so
          only the banner's own flash may end it. */}
      <div
        key={mode}
        className="ken-power-banner"
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) onDone();
        }}
      >
        <KenFace mood={mode} />
        <span>{mode === "on" ? `${MENTOR_NAME} is on.` : `${MENTOR_NAME} is off.`}</span>
      </div>
    </div>
  );
}
