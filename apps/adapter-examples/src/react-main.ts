import { defineVibeGlobe, type VibeGlobeElement } from '@vibeglobe/web-component';
import { createElement, useEffect, useRef, useState, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { elementHooks, ELEMENT_EVENTS } from './element-hooks.js';
import { backend, BASE_IMAGERY_URL, type ExampleEvent } from './hooks.js';

// F483: the element inside a React app, registered under a custom tag name when `?tag=` is set.
defineVibeGlobe();
const events: ExampleEvent[] = [];

function Globe(): ReactElement {
  const ref = useRef<VibeGlobeElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const listeners = ELEMENT_EVENTS.map((type) => {
      const listener = (event: Event): void =>
        void events.push({ source: 'react', type, payload: (event as CustomEvent).detail });
      element.addEventListener(type, listener);
      return () => element.removeEventListener(type, listener);
    });
    return () => listeners.forEach((stop) => stop());
  }, []);
  return createElement('vibe-globe', {
    ref,
    'base-imagery-url': BASE_IMAGERY_URL,
    backend,
    center: '12.5, 41.9',
    zoom: '3',
    style: { display: 'block', height: '100%' },
  });
}

let setShown: (shown: boolean) => void = () => undefined;
function App(): ReactElement | null {
  const [shown, set] = useState(true);
  setShown = set;
  return shown ? createElement(Globe) : null;
}

const container = document.querySelector('#app');
if (container) createRoot(container).render(createElement(App));
window.adapterExample = elementHooks(events, async (shown) => flushSync(() => setShown(shown)));
