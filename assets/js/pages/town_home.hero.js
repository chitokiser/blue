// /assets/js/pages/town_home.hero.js
// 이미지 슬라이드쇼 히어로 — crossfade, 4초 간격, IntersectionObserver 일시정지

(function () {
  const section = document.getElementById('heroSection');
  if (!section) return;

  const slides = Array.from(section.querySelectorAll('.hero-slide'));
  if (slides.length === 0) return;

  // 인디케이터 도트 생성
  const dotsWrap = document.createElement('div');
  dotsWrap.className = 'hero-dots';
  slides.forEach((_, i) => {
    const dot = document.createElement('button');
    dot.className = 'hero-dot' + (i === 0 ? ' active' : '');
    dot.setAttribute('aria-label', `슬라이드 ${i + 1}`);
    dot.addEventListener('click', () => goTo(i));
    dotsWrap.appendChild(dot);
  });
  section.appendChild(dotsWrap);

  const dots = Array.from(dotsWrap.querySelectorAll('.hero-dot'));
  let current = 0;
  let timer = null;

  function goTo(idx) {
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');
    current = (idx + slides.length) % slides.length;
    slides[current].classList.add('active');
    dots[current].classList.add('active');
  }

  function next() { goTo(current + 1); }

  function start() {
    if (timer) return;
    timer = setInterval(next, 4000);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // prefers-reduced-motion 시 첫 장만 표시
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // 뷰포트 진입 시 재생, 벗어나면 정지
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) { start(); } else { stop(); }
      });
    },
    { threshold: 0.1 }
  );

  observer.observe(section);
})();
