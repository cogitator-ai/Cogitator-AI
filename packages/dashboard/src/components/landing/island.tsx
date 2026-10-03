'use client';

import {
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from 'react';

/** How far outside the viewport an island goes live: one screen ahead in either direction. */
const NEAR_VIEWPORT = '100% 0px 100% 0px';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

const subscribeNothing = () => () => {};

/** False on the server and while React hydrates; true once the tree renders on the client. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false
  );
}

const NO_HTML = { __html: '' };

export interface IslandOptions<P> {
  /** Runs alongside the module load before the island goes live, e.g. to fetch a nested chunk. */
  prepare?: (props: P) => Promise<unknown>;
}

/**
 * Wraps a below-the-fold client component so its JS loads only when it comes within a screen of
 * the viewport. The server renders it in full, so its text stays in the HTML; on the client the
 * server HTML stays untouched (not hydrated) until then, and the component replaces it in one
 * commit with the same markup, so nothing shifts. If the chunk fails to load, the HTML stays.
 *
 * The wrapper is `display: contents`, so the component lays out exactly as if unwrapped.
 */
export function island<P extends object>(
  load: () => Promise<ComponentType<P>>,
  options: IslandOptions<P> = {}
): ComponentType<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const loadOnce = () =>
    (pending ??= load().then((component) => {
      loaded = component;
      return component;
    }));

  if (typeof window === 'undefined') {
    loadOnce().catch(() => {});
  }

  function Live(props: P) {
    const Content = loaded ?? use(loadOnce());
    return <Content {...props} />;
  }

  function Island(props: P) {
    const hydrated = useHydrated();
    const [live, setLive] = useState(hydrated);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const propsRef = useRef(props);
    const focusIndex = useRef(-1);

    useEffect(() => {
      propsRef.current = props;
    });

    useEffect(() => {
      if (live) return;
      const wrapper = wrapperRef.current;
      let cancelled = false;

      const goLive = () => {
        Promise.all([loadOnce(), options.prepare?.(propsRef.current)]).then(
          () => {
            if (cancelled || !wrapper) return;
            const focused = document.activeElement;
            focusIndex.current =
              focused && wrapper.contains(focused)
                ? Array.from(wrapper.querySelectorAll(FOCUSABLE)).indexOf(focused)
                : -1;
            setLive(true);
          },
          () => {}
        );
      };

      const target = wrapper?.firstElementChild;
      if (!target || typeof IntersectionObserver === 'undefined') {
        goLive();
        return () => {
          cancelled = true;
        };
      }
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer.disconnect();
          goLive();
        },
        { rootMargin: NEAR_VIEWPORT }
      );
      observer.observe(target);
      return () => {
        cancelled = true;
        observer.disconnect();
      };
    }, [live]);

    useLayoutEffect(() => {
      if (!live || focusIndex.current < 0) return;
      const target =
        wrapperRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)[focusIndex.current];
      focusIndex.current = -1;
      target?.focus({ preventScroll: true });
    }, [live]);

    if (live || typeof window === 'undefined') {
      return (
        <div ref={wrapperRef} className="contents">
          <Live {...props} />
        </div>
      );
    }
    return (
      <div
        ref={wrapperRef}
        className="contents"
        suppressHydrationWarning
        dangerouslySetInnerHTML={NO_HTML}
      />
    );
  }

  return Island;
}
