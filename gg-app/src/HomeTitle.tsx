import title from "./assets/home/godik-coder-title.png";

/** The title art's size in its own pixels (see scripts/gen-home-title.py). */
export const HOME_TITLE_W = 276;
export const HOME_TITLE_H = 39;

/**
 * The home screen's "GG Coder" title, lettered like GG Royale's "Royale" (gold
 * Alagard at 48px with an ink outline). A still image shown at a whole number
 * of screen pixels per art pixel, so it stays crisp; no looping motion.
 */
export function HomeTitle(): React.ReactElement {
  return (
    <h1 className="home-title">
      <img
        className="home-title-art"
        src={title}
        alt="GODIK Coder"
        width={HOME_TITLE_W}
        height={HOME_TITLE_H}
        draggable={false}
      />
    </h1>
  );
}
