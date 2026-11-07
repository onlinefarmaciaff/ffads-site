// Тема оформления: выбор пользователя хранится в localStorage, иначе — системная.
// Подключается обычным скриптом в <head>, чтобы тема применилась до отрисовки.
(function () {
  var KEY = 'ffads-theme';
  var root = document.documentElement;

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function apply(theme) {
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  }

  apply(stored());

  window.ffadsTheme = {
    current: function () {
      var t = root.getAttribute('data-theme');
      if (t) return t;
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    },
    toggle: function () {
      var next = this.current() === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* хранилище недоступно */ }
      return next;
    },
  };
})();
