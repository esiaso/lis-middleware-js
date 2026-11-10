// Remembers which menu groups this browser folded (a convenience only: with
// no script, or no storage, every group is simply shown open). The group that
// holds the current page is always open.
(function () {
  'use strict';
  var KEY = 'lims.nav.folded';
  var folded = [];
  try { folded = JSON.parse(window.localStorage.getItem(KEY) || '[]'); } catch (e) { folded = []; }
  if (!Array.isArray(folded)) folded = [];
  var groups = document.querySelectorAll('details.app-nav-group');
  groups.forEach(function (d) {
    var key = d.getAttribute('data-group');
    if (!d.hasAttribute('data-current') && folded.indexOf(key) !== -1) d.open = false;
    d.addEventListener('toggle', function () {
      var i = folded.indexOf(key);
      if (d.open && i !== -1) folded.splice(i, 1);
      if (!d.open && i === -1) folded.push(key);
      try { window.localStorage.setItem(KEY, JSON.stringify(folded)); } catch (e) { /* storage blocked: nothing to remember */ }
    });
  });
})();

// Wide tables scroll sideways inside their own box on small screens, instead of the page.
(function () {
  'use strict';
  document.querySelectorAll('.app-main table.table').forEach(function (t) {
    if (t.closest('.table-responsive, .result-report')) return;
    var box = document.createElement('div');
    box.className = 'table-responsive';
    t.parentNode.insertBefore(box, t);
    box.appendChild(t);
  });
})();

// A Print button on printable pages (the page prints the same with Ctrl+P).
(function () {
  'use strict';
  document.querySelectorAll('[data-print]').forEach(function (b) {
    b.addEventListener('click', function () { window.print(); });
  });
})();

// Page notes (.note) and field hints (.form-text) start folded; an info icon
// beside the heading or label they belong to shows them. A heading's icon
// shows all the notes under it. Where there is no heading or label, a
// "More info" link takes the note's place.
(function () {
  'use strict';
  var SVG = 'http://www.w3.org/2000/svg';
  var seq = 0;
  function infoButton(withText) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = withText ? 'more-info-btn more-info-inline' : 'more-info-btn';
    b.setAttribute('aria-expanded', 'false');
    b.title = 'More info';
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'bi');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(SVG, 'use');
    use.setAttribute('href', '/static/icons.svg#info-circle');
    svg.appendChild(use);
    b.appendChild(svg);
    var label = document.createElement('span');
    label.className = withText ? '' : 'visually-hidden';
    label.textContent = 'More info';
    b.appendChild(label);
    b.addEventListener('click', function () {
      var open = b.getAttribute('aria-expanded') !== 'true';
      b.setAttribute('aria-expanded', String(open));
      (b.getAttribute('aria-controls') || '').split(' ').forEach(function (id) {
        var n = id && document.getElementById(id);
        if (n) n.classList.toggle('note-open', open);
      });
    });
    return b;
  }
  function headingBefore(el) {
    for (var s = el.previousElementSibling; s; s = s.previousElementSibling) {
      if (/^H[1-6]$/.test(s.tagName)) return s;
      var h = s.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6');
      if (h) return h;
    }
    return null;
  }
  var buttons = new Map();
  function attach(note, anchor) {
    if (!note.id) note.id = 'note-' + (++seq);
    var b = anchor && buttons.get(anchor);
    if (!b) {
      b = infoButton(!anchor);
      if (anchor) { if (anchor.tagName === 'LABEL') anchor.after(b); else anchor.appendChild(b); buttons.set(anchor, b); } else note.parentNode.insertBefore(b, note);
    }
    b.setAttribute('aria-controls', ((b.getAttribute('aria-controls') || '') + ' ' + note.id).trim());
  }
  document.querySelectorAll('.app-main .note').forEach(function (n) { attach(n, headingBefore(n)); });
  document.querySelectorAll('.app-main .form-text').forEach(function (n) {
    var box = n.parentElement;
    attach(n, box ? box.querySelector(':scope > label, :scope > .form-label, :scope > .form-check-label') : null);
  });
})();

// Parts of a form that apply to one choice only ([data-show-for="name:A B"])
// are shown when that choice is picked. Hidden parts are disabled so their
// fields are not sent. With no script, every part is shown.
(function () {
  'use strict';
  document.querySelectorAll('form').forEach(function (form) {
    var parts = form.querySelectorAll('[data-show-for]');
    if (!parts.length) return;
    function update() {
      parts.forEach(function (p) {
        var spec = p.getAttribute('data-show-for').split(':');
        var picked = form.querySelector('input[name="' + spec[0] + '"]:checked, select[name="' + spec[0] + '"]');
        var on = !!picked && spec[1].split(' ').indexOf(picked.value) !== -1;
        p.classList.toggle('is-shown', on);
        p.querySelectorAll('input, select, textarea, button').forEach(function (f) { f.disabled = !on; });
      });
    }
    form.addEventListener('change', update);
    update();
  });
})();

// "Add an answer" copies the last answer row, empty, with the next number.
(function () {
  'use strict';
  document.querySelectorAll('[data-add-answer]').forEach(function (btn) {
    var form = btn.closest('form');
    var body = form && form.querySelector('[data-answer-rows]');
    if (!body) return;
    btn.hidden = false;
    btn.addEventListener('click', function () {
      var last = body.lastElementChild;
      var n = body.children.length;
      var row = last.cloneNode(true);
      row.querySelectorAll('input, select').forEach(function (f) {
        f.name = f.name.replace(/^answer-\d+-/, 'answer-' + n + '-');
        if (f.id) f.id = f.id.replace(/^answer-\d+-/, 'answer-' + n + '-');
        var label = f.getAttribute('aria-label');
        if (label) f.setAttribute('aria-label', label.replace(/Answer \d+/, 'Answer ' + n));
        if (f.tagName === 'SELECT') f.selectedIndex = 0; else f.value = '';
      });
      body.appendChild(row);
      row.querySelector('input').focus();
    });
  });
})();
