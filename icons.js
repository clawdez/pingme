/* pingme — hand-drawn icon set (2.5px ink stroke, wobble filter).
   Exposed as window.PMIcons.icon(name, opts) and window.PMIcons.ICONS.
   The shared <defs id="pm-icons-defs"> wobble filter is injected once at load. */
(function () {
  'use strict';

  // ---- shared svg attrs: hand-drawn ink stroke ----
  // Stroke widths slightly heavier so the marker holds at small sizes.
  var S  = 'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#wobble)"';
  var Sf = 'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#wobble)"';

  // ---- the icon library (viewBox 0 0 40 40) ----
  var ICONS = {
    settings: '<g ' + S + '>' +
      '<path d="M17 5 L23 5 L24 9.2 L27.4 11 L31.4 9.4 L34.4 14.6 L31.6 17.6 L31.6 22.4 L34.4 25.4 L31.4 30.6 L27.4 29 L24 30.8 L23 35 L17 35 L16 30.8 L12.6 29 L8.6 30.6 L5.6 25.4 L8.4 22.4 L8.4 17.6 L5.6 14.6 L8.6 9.4 L12.6 11 L16 9.2 Z"/>' +
      '<circle cx="20" cy="20" r="5.5"/>' +
    '</g>',

    bell: '<g ' + S + '>' +
      '<path d="M11 26 L29 26 L27.5 20 C27.5 12 24 9 20 9 C16 9 12.5 12 12.5 20 Z"/>' +
      '<path d="M16.5 26 C16.5 30 23.5 30 23.5 26"/>' +
      '<path d="M20 5 L20 9"/>' +
    '</g>',

    star: '<path d="M20 6 L24 16 L34.5 16.5 L26.5 23.5 L29 33.5 L20 27.5 L11 33.5 L13.5 23.5 L5.5 16.5 L16 16 Z" ' + S + '/>',

    starFilled: '<path d="M20 6 L24 16 L34.5 16.5 L26.5 23.5 L29 33.5 L20 27.5 L11 33.5 L13.5 23.5 L5.5 16.5 L16 16 Z" fill="#E8B84A" ' + Sf + '/>',

    send: '<g ' + S + '>' +
      '<path d="M34 6 L4 17.5 L17 21.5 L21 33 Z"/>' +
      '<path d="M17 21.5 L34 6"/>' +
    '</g>',

    close: '<path d="M9 9 L31 31 M31 9 L9 31" ' + S + '/>',

    edit: '<g ' + S + '>' +
      '<path d="M6 34 L7.5 27 L26 8.5 L31.5 14 L13 32.5 Z"/>' +
      '<path d="M23 11.5 L28.5 17"/>' +
      '<path d="M6 34 L13 32.5"/>' +
    '</g>',

    email: '<g ' + S + '>' +
      '<rect x="5" y="9" width="30" height="22" rx="3"/>' +
      '<path d="M6.5 11 L20 22 L33.5 11"/>' +
    '</g>',

    phone: '<path d="M11 5 C9 5 6 6.5 6 11 C6 22 18 34 29 34 C33.5 34 35 31 35 29 L28 24 L23.5 27 C20 25 15 20 13 16.5 L16 12 Z" ' + S + '/>',

    verified: '<g ' + S + '>' +
      '<path d="M20 4 L24 7 L29 6.5 L30.5 11.5 L34.5 14.5 L32.5 19 L33 24 L28 26 L25.5 30.5 L20 29 L14.5 30.5 L12 26 L7 24 L7.5 19 L5.5 14.5 L9.5 11.5 L11 6.5 L16 7 Z"/>' +
      '<path d="M14.5 19.5 L18.5 23.5 L26 15" stroke-width="2.6"/>' +
    '</g>',

    add: '<path d="M20 8 L20 32 M8 20 L32 20" ' + S + '/>',

    search: '<g ' + S + '>' +
      '<circle cx="17" cy="17" r="10"/>' +
      '<path d="M24.5 24.5 L33 33"/>' +
    '</g>',

    pin: '<g ' + S + '>' +
      '<path d="M20 35 C20 35 31 24.5 31 16 C31 9.5 26 5 20 5 C14 5 9 9.5 9 16 C9 24.5 20 35 20 35 Z"/>' +
      '<circle cx="20" cy="16" r="4.5"/>' +
    '</g>',

    back: '<path d="M24 7 L11 20 L24 33 M11 20 L34 20" ' + S + '/>',

    qr: '<g ' + S + '>' +
      '<rect x="6" y="6" width="11" height="11" rx="2"/>' +
      '<rect x="23" y="6" width="11" height="11" rx="2"/>' +
      '<rect x="6" y="23" width="11" height="11" rx="2"/>' +
      '<path d="M10.5 10.5 L12.5 10.5 M27.5 10.5 L29.5 10.5 M10.5 27.5 L12.5 27.5" stroke-width="3.2"/>' +
      '<path d="M23 23 L27 23 L27 27 M31 23 L34 23 M23 31 L23 34 M27 30 L27 34 L31 34 M31 28 L34 28 M34 31 L34 34"/>' +
    '</g>'
  };

  // Render an SVG string for an icon.
  // opts: { size:number=24, color?:string, title?:string, attr?:string }
  function icon(name, opts) {
    opts = opts || {};
    var src = ICONS[name];
    if (!src) return '';
    var size = opts.size || 24;
    var color = opts.color ? ' style="color:' + opts.color + '"' : '';
    var title = opts.title ? '<title>' + String(opts.title).replace(/[<>"&]/g, '') + '</title>' : '';
    var extra = opts.attr ? ' ' + opts.attr : '';
    return '<svg class="pm-ic pm-ic-' + name + '" width="' + size + '" height="' + size + '" viewBox="0 0 40 40" aria-hidden="true"' + color + extra + '>' + title + src + '</svg>';
  }

  // Inject the wobble filter once. The index.html already declares
  // <filter id="wobble">, but we re-declare into a dedicated <svg> in case
  // the page is loaded standalone or the original is removed.
  function injectDefs() {
    if (document.getElementById('pm-icons-defs')) return;
    if (document.querySelector('filter#wobble')) return; // already present
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('id', 'pm-icons-defs');
    s.setAttribute('width', '0');
    s.setAttribute('height', '0');
    s.setAttribute('aria-hidden', 'true');
    s.style.position = 'absolute';
    s.innerHTML =
      '<defs>' +
        '<filter id="wobble" x="-6%" y="-6%" width="112%" height="112%">' +
          '<feTurbulence type="fractalNoise" baseFrequency="0.022" numOctaves="2" seed="4" result="t"/>' +
          '<feDisplacementMap in="SourceGraphic" in2="t" scale="1.4"/>' +
        '</filter>' +
      '</defs>';
    (document.body || document.documentElement).appendChild(s);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectDefs);
  } else {
    injectDefs();
  }

  window.PMIcons = { ICONS: ICONS, icon: icon, injectDefs: injectDefs };
})();
