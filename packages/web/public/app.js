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
