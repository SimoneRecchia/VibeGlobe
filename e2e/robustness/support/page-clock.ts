// The page lifecycle as the browser drives it, for the hidden-tab and sleep scenarios (F515, F516). Headless Chromium
// neither hides a page (another tab in front leaves it visible) nor acts on CDP `Page.setWebLifecycleState`, so an
// init script overrides `document.visibilityState` and the clock the engine reads (`performance.now`, `Date.now`),
// and dispatches the events the browser would.

/** Init script: `window.setHidden(hidden, jumpMs)` hides or shows the page and moves its clock on by `jumpMs`. */
export function lifecycleControls(): void {
  let visibility: DocumentVisibilityState = 'visible';
  let offsetMs = 0;
  Object.defineProperty(document, 'visibilityState', { get: () => visibility });
  Object.defineProperty(document, 'hidden', { get: () => visibility === 'hidden' });
  const now = performance.now.bind(performance);
  const dateNow = Date.now.bind(Date);
  performance.now = () => now() + offsetMs;
  Date.now = () => dateNow() + offsetMs;
  const w = window as unknown as {
    setHidden: (hidden: boolean, jumpMs?: number) => void;
    freeze: () => void;
    resume: (sleptMs: number) => void;
    lifecycle: string[];
  };
  w.lifecycle = [];
  for (const type of ['freeze', 'resume', 'visibilitychange'])
    document.addEventListener(type, () => w.lifecycle.push(type));
  w.setHidden = (hidden, jumpMs = 0) => {
    visibility = hidden ? 'hidden' : 'visible';
    offsetMs += jumpMs;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  // A frozen page is hidden first (page lifecycle: active, hidden, frozen); it resumes hidden, then shows.
  w.freeze = () => {
    w.setHidden(true);
    document.dispatchEvent(new Event('freeze'));
  };
  w.resume = (sleptMs) => {
    offsetMs += sleptMs;
    document.dispatchEvent(new Event('resume'));
    w.setHidden(false);
  };
}
