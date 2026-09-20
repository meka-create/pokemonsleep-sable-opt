
  (() => {
    'use strict';
    const TIPS_SEEN_KEY = 'mewtwo_tips_seen_v1';
    const tipsBtn = document.getElementById('tipsBtn');
    const tipsDialog = document.getElementById('tipsDialog');
    const tipsClose = document.getElementById('tipsClose');
    if (!tipsBtn || !tipsDialog || !tipsClose) return;

    let seen = false;
    try { seen = localStorage.getItem(TIPS_SEEN_KEY) === '1'; } catch {}
    tipsBtn.classList.toggle('unseen', !seen);

    const markSeen = () => {
      tipsBtn.classList.remove('unseen');
      try { localStorage.setItem(TIPS_SEEN_KEY, '1'); } catch {}
    };
    const openTips = () => {
      markSeen();
      if (typeof tipsDialog.showModal === 'function') tipsDialog.showModal();
      else tipsDialog.setAttribute('open', '');
    };
    const closeTips = () => {
      if (typeof tipsDialog.close === 'function') tipsDialog.close();
      else tipsDialog.removeAttribute('open');
    };

    tipsBtn.addEventListener('click', openTips);
    tipsClose.addEventListener('click', closeTips);
    tipsDialog.addEventListener('click', (event) => {
      if (event.target === tipsDialog) closeTips();
    });
  })();
  