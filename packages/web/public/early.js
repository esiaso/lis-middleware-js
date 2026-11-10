// Runs before the page is drawn: marks that scripts run, so page notes and
// field hints can start folded behind their "more info" icons without a
// flash. With no script, every note simply stays visible.
document.documentElement.classList.add('js');
