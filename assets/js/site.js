/*
 * Keke LE Design — site.js
 *
 * - List pages (index / research): hover/touch/focus prefetch so the next
 *   document is in cache by the time the user actually clicks.
 * - Detail pages: a concurrent download queue that fires the moment the page
 *   parses. Items start in document order (top to bottom) and the queue
 *   adapts to the user's scroll position by bumping near-viewport items to
 *   the front, so scrolling fast doesn't make the user wait. Concurrency is
 *   tuned from the navigator's effective network type when available.
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

  function pickConcurrency() {
    try {
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (c && c.saveData) return 2;
      if (c && c.effectiveType) {
        switch (c.effectiveType) {
          case 'slow-2g':
          case '2g':
            return 2;
          case '3g':
            return 4;
          case '4g':
            return 8;
        }
      }
    } catch (e) { /* noop */ }
    return 6;
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

    var queue = targets.slice();
    var inFlight = 0;
    var started = new WeakSet();
    var concurrency = pickConcurrency();

    function pump() {
      while (inFlight < concurrency && queue.length) {
        var el = queue.shift();
        if (started.has(el)) continue;
        started.add(el);
        inFlight++;
        var task = (el.tagName === 'IMG') ? loadImage(el) : loadVideo(el);
        task.then(function () {
          inFlight--;
          pump();
        }, function () {
          inFlight--;
          pump();
        });
      }
    }

    pump();

    // Scroll-driven priority: sort the entire pending queue by distance to
    // the current viewport so the very next slot that frees always picks
    // the element closest to where the user is looking, regardless of how
    // far it sits in the document. Items already scrolled past are
    // deprioritised but kept (in case the user scrolls back).
    var scheduled = false;
    function reprioritise() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        if (queue.length < 2) return;
        var vh = window.innerHeight || 800;
        queue.sort(function (a, b) {
          return scoreFor(a, vh) - scoreFor(b, vh);
        });
        pump();
      });
    }

    function scoreFor(el, vh) {
      var rect = el.getBoundingClientRect();
      // Inside or below viewport: distance to top of viewport, never below 0.
      if (rect.bottom > 0) return Math.max(0, rect.top);
      // Already scrolled past — heavily deprioritised but still queued so a
      // back-scroll won't show an empty box.
      return Math.abs(rect.bottom) + 100000;
    }

    window.addEventListener('scroll', reprioritise, { passive: true });
    window.addEventListener('resize', reprioritise, { passive: true });

    // Pause out-of-view videos so the browser doesn't have to keep dozens of
    // hardware decoders / decoded frame buffers alive at once. This is what
    // was blowing up the page on heavy detail views: too many active <video>
    // elements made the renderer process bail and the tab go white.
    setupVideoVisibility();
  }

  function setupVideoVisibility() {
    if (!('IntersectionObserver' in window)) return;
    var videos = document.querySelectorAll('.detail_container video');
    if (!videos.length) return;

    var visible = new WeakSet();

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var v = entry.target;
        if (entry.isIntersecting) {
          visible.add(v);
          // Only resume autoplay videos; never start one the user paused
          // manually (none in this site, but defensive).
          if (v.autoplay && v.paused && v.readyState >= 2) {
            var p = v.play();
            if (p && typeof p.catch === 'function') p.catch(function () {});
          }
        } else {
          visible.delete(v);
          if (!v.paused) {
            try { v.pause(); } catch (e) { /* noop */ }
          }
        }
      });
    }, { rootMargin: '200px 0px', threshold: 0.01 });

    videos.forEach(function (v) { io.observe(v); });
  }

  // The moment the user commits to a navigation (pointerdown / click on a
  // same-origin link), capture the frame each on-screen <video> is currently
  // showing and stamp it as a plain <img> overlay positioned exactly on top
  // of that video. Because a static <img> in the DOM can't be torn down by
  // the browser the way a <video>'s decoded frame can, the cover appears to
  // freeze in place during the transition — no blanking on Safari, no
  // rewind to first frame, no poster getting stuck after a back navigation.
  function freezeVideoFramesOnNavigation() {
    var FREEZE_CLASS = 'site_video_freeze';

    function videoIsOnScreen(v) {
      var rect = v.getBoundingClientRect();
      var vh = window.innerHeight || 0;
      return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.width > 0;
    }

    function freezeOne(v) {
      if (!v || v.readyState < 2) return;
      if (!v.videoWidth || !v.videoHeight) return;
      if (!videoIsOnScreen(v)) return;
      if (v.__siteFrozen) return;
      v.__siteFrozen = true;

      try {
        var scale = 0.5;
        var w = Math.max(1, Math.round(v.videoWidth * scale));
        var h = Math.max(1, Math.round(v.videoHeight * scale));
        var c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        var dataURL = c.toDataURL('image/jpeg', 0.78);

        var parent = v.parentNode;
        if (!parent) return;
        var parentRect = parent.getBoundingClientRect();
        var vRect = v.getBoundingClientRect();

        var img = document.createElement('img');
        img.src = dataURL;
        img.className = FREEZE_CLASS;
        img.style.left = (vRect.left - parentRect.left) + 'px';
        img.style.top = (vRect.top - parentRect.top) + 'px';
        img.style.width = vRect.width + 'px';
        img.style.height = vRect.height + 'px';

        parent.appendChild(img);
      } catch (e) {
        v.__siteFrozen = false;
      }
    }

    function freezeAll() {
      var videos = document.querySelectorAll('video');
      for (var i = 0; i < videos.length; i++) freezeOne(videos[i]);
    }

    function isInternalLink(node) {
      var a = node && node.closest && node.closest('a[href]');
      if (!a) return false;
      if (a.target && a.target !== '_self') return false;
      try {
        return new URL(a.href).origin === location.origin;
      } catch (e) { return false; }
    }

    document.addEventListener('pointerdown', function (e) {
      if (isInternalLink(e.target)) freezeAll();
    }, true);
    // Backup for keyboard activation (Tab + Enter) which skips pointerdown.
    document.addEventListener('click', function (e) {
      if (isInternalLink(e.target)) freezeAll();
    }, true);

    // When the browser restores this page from BFCache (back/forward), strip
    // out any leftover freeze overlays from the previous departure and make
    // sure autoplay videos start playing again.
    window.addEventListener('pageshow', function (e) {
      if (!e.persisted) return;
      var overlays = document.querySelectorAll('.' + FREEZE_CLASS);
      for (var i = 0; i < overlays.length; i++) overlays[i].remove();
      var videos = document.querySelectorAll('video');
      for (var j = 0; j < videos.length; j++) {
        var v = videos[j];
        v.__siteFrozen = false;
        // Clear any stale poster from a previous build of this code.
        if (v.hasAttribute('poster') && /^data:/.test(v.getAttribute('poster'))) {
          v.removeAttribute('poster');
        }
        if (v.autoplay && v.paused) {
          var p = v.play();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        }
      }
    });
  }

  function boot() {
    if (isListPage) initListPage();
    if (isDetailPage) initDetailPage();
    freezeVideoFramesOnNavigation();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
