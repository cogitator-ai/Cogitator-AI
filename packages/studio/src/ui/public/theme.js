try {
  var theme = localStorage.getItem('cogitator-studio-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch (error) {}
