const langToggle = document.querySelector("#lang-toggle");
const langText = document.querySelector("#lang-text");
const langLink = document.querySelector("#lang-link");

let lang = "ru"; // По умолчанию язык установлен на русский

function setLang(langCode, langName) {
  langText.innerText = langName;
  langLink.href = langCode + ".html";
  lang = langCode;
}

langToggle.addEventListener("click", () => {
  if (lang === "ru") {
    setLang("uk", "Українська");
  } else {
    setLang("ru", "Русский");
  }
});
