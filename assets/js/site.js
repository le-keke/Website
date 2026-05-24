/*
 * Keke LE Design — site.js
 *
 * - List pages (index / research): hover/touch/focus prefetch so the next
 *   document is in cache by the time the user actually clicks.
 * - Detail pages: IntersectionObserver-driven lazy loading with a wide
 *   preload margin (~2 screens above and below the viewport). Whatever
 *   enters that area starts loading; once loaded it stays loaded. The
 *   browser's own connection pool handles concurrency. No global queue,
 *   no in-flight slot starvation, no penalty for scrolling back to revisit
 *   earlier sections.
 */
(function () {
  'use strict';

  var isListPage = !!document.querySelector('.thumbnail_container, #research_body');
  var isDetailPage = !!document.querySelector('.detail_container');

  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    return false;
  });

  function initListPage() {
    var warmed = Object.create(null);
    var links = document.querySelectorAll('a[href$=".html"]');

    function warm(url) {
      if (!url || warmed[url] || url === location.href) return;
      if (url.indexOf(location.origin) !== 0) return;
      warmed[url] = true;
      var hint = document.createElement('link');
      hint.rel = 'prefetch';
      hint.as = 'document';
      hint.href = url;
      document.head.appendChild(hint);
    }

    links.forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href) return;
      var url;
      try { url = new URL(href, location.href).href; } catch (e) { return; }

      var trigger = function () { warm(url); };
      link.addEventListener('mouseenter', trigger, { passive: true });
      link.addEventListener('focus', trigger, { passive: true });
      link.addEventListener('touchstart', trigger, { passive: true });
    });
  }

  function isNearViewport(el) {
    var rect = el.getBoundingClientRect();
    var vh = window.innerHeight || 800;
    return rect.bottom > -vh && rect.top < vh * 2;
  }

  function loadImage(el) {
    return new Promise(function (resolve) {
      var src = el.getAttribute('data-src');
      if (!src) return resolve();
      var done = function () {
        el.style.opacity = '1';
        resolve();
      };
      el.addEventListener('load', done, { once: true });
      el.addEventListener('error', done, { once: true });
      if (!el.hasAttribute('decoding')) el.setAttribute('decoding', 'async');
      // Hint the browser to allocate bandwidth to whatever the user is
      // currently looking at (or about to look at).
      if (isNearViewport(el) && !el.hasAttribute('fetchpriority')) {
        el.setAttribute('fetchpriority', 'high');
      }
      el.setAttribute('src', src);
      el.removeAttribute('data-src');
    });
  }

  function loadVideo(el) {
    return new Promise(function (resolve) {
      var sources = el.querySelectorAll('source[data-src]');
      if (!sources.length) return resolve();
      for (var i = 0; i < sources.length; i++) {
        sources[i].setAttribute('src', sources[i].getAttribute('data-src'));
        sources[i].removeAttribute('data-src');
      }
      el.setAttribute('preload', 'auto');
      var done = function () {
        el.style.opacity = '1';
        el.removeAttribute('data-lazy');
        // If the video happens to be far below the viewport when its first
        // frame becomes available, don't let autoplay kick in — the
        // visibility observer will resume it when it scrolls into view.
        if (!isNearViewport(el)) {
          try { el.pause(); } catch (e) { /* noop */ }
        }
        resolve();
      };
      // Move on as soon as a frame is renderable so a slow video doesn't
      // block the rest of the page.
      el.addEventListener('loadeddata', done, { once: true });
      el.addEventListener('error', done, { once: true });
      try { el.load(); } catch (e) { /* noop */ }
      setTimeout(done, 1500);
    });
  }

  function initDetailPage() {
    var targets = Array.prototype.slice.call(
      document.querySelectorAll('img[data-src], video[data-lazy]')
    );
    if (!targets.length) return;

    function startLoad(el) {
      if (el.tagName === 'IMG') loadImage(el);
      else loadVideo(el);
    }

    // Old browser fallback: no IO available, just load everything.
    if (!('IntersectionObserver' in window)) {
      targets.forEach(startLoad);
      setupVideoVisibility();
      return;
    }

    // Generous preload margin (~2 screens above and below). The browser's
    // own request scheduler handles concurrency, which is smarter than a
    // hand-rolled queue and never gets stuck on slow in-flight requests.
    // Re-entering the margin (scrolling back up) re-triggers load for
    // anything still pending, so a fast scroll-past never leaves a blank.
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        io.unobserve(el);
        startLoad(el);
      });
    }, { rootMargin: '2000px 0px', threshold: 0.01 });

    targets.forEach(function (el) { io.observe(el); });

    // Pause out-of-view videos so the browser doesn't have to keep dozens
    // of hardware decoders / decoded frame buffers alive at once. This is
    // what was making heavy detail views go white on long scrolls.
    setupVideoVisibility();
  }

  function setupVideoVisibility() {
    if (!('IntersectionObserver' in window)) return;
    // All autoplay videos on this page, regardless of whether they live
    // inside a .detail_container or sit between sections as a full-width
    // standalone block (e.g. taobaovp's big videos). The previous
    // .detail_container scope silently dropped the latter.
    var videos = document.querySelectorAll('video[autoplay]');
    if (!videos.length) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var v = entry.target;
        if (entry.isIntersecting) {
          // Don't gate on readyState here — play() is async and will buffer
          // first then start playback if the video hasn't loaded enough.
          // Gating used to leave slow-loading videos stuck on frame 0 after
          // the visibility observer's one-shot initial fire missed the
          // readiness window.
          if (v.paused) {
            var p = v.play();
            if (p && typeof p.catch === 'function') p.catch(function () {});
          }
        } else if (!v.paused) {
          try { v.pause(); } catch (e) { /* noop */ }
        }
      });
    }, { rootMargin: '200px 0px', threshold: 0.01 });

    videos.forEach(function (v) { io.observe(v); });
  }

  function boot() {
    if (isListPage) initListPage();
    if (isDetailPage) initDetailPage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
