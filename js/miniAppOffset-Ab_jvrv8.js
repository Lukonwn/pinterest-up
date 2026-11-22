// Chunk recriado: o arquivo original não estava no repositório e o import dinâmico dava 404,
// derrubando a página. Contrato esperado pelo bundle:
//   applyMiniAppHeaderMode(enabled) -> função de limpeza
//   ensureTelegramScript() -> garante o carregamento do SDK do Telegram
const ROOT_CLASS = "mini-app-header";

export function ensureTelegramScript() {
  if (window.Telegram?.WebApp) return;
  if (document.querySelector('script[src*="telegram-web-app"]')) return;
  const s = document.createElement("script");
  s.src = "js/telegram-web-app.js";
  document.head.appendChild(s);
}

export function applyMiniAppHeaderMode(enabled) {
  const root = document.documentElement;
  if (!enabled) {
    root.classList.remove(ROOT_CLASS);
    return () => {};
  }
  root.classList.add(ROOT_CLASS);
  return () => {
    root.classList.remove(ROOT_CLASS);
    root.style.removeProperty("--mini-app-header-offset");
  };
}
