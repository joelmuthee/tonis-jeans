// Toni's Jeans & Tees — frontend catalog
const IMG_VERSION = 'v1';
const API_BASE = 'https://tonisjeansandtees-api.stawisystems.workers.dev';
(async function() {
  const gallery = document.getElementById('gallery');
  const filterMeta = document.getElementById('filterMeta');
  const availPills = document.getElementById('availPills');
  const catPills = document.getElementById('catPills');
  const sizePills = document.getElementById('sizePills');
  let items = [];
  let settings = {};
  let currentAvail = 'all';
  let currentCat = 'all';
  let currentSize = 'all';

  async function loadData() {
    try {
      const res = await fetch(`${API_BASE}/api/bags?_=${Date.now()}`);
      const json = await res.json();
      items = json.bags || [];
      settings = json.settings || {};
    } catch(e) {
      try {
        const res = await fetch('data.json');
        const json = await res.json();
        items = json.bags || [];
        settings = json.settings || {};
      } catch(e2) { items = []; }
    }
  }

  function fmtPrice(n) {
    return 'Ksh ' + Number(n).toLocaleString('en-KE');
  }

  function whatsappLink(item) {
    const phone = (settings.whatsappNumber || '254721623937');
    const sizePart = item.sizes && item.sizes.length ? ` (sizes: ${item.sizes.join(', ')})` : '';
    const msg = `Hi Toni! I'd like to enquire about the *${item.name}*${sizePart} (${fmtPrice(item.price)}) from your catalog.\n\nLink: ${item.reel || 'https://www.instagram.com/tonis_jeans_and_tees/'}`;
    return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function getCategories() {
    return [...new Set(items.map(i => i.category).filter(Boolean))].sort();
  }

  function sortSize(a, b) {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    if (!isNaN(na)) return -1;
    if (!isNaN(nb)) return 1;
    const order = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
    const ia = order.indexOf(a.toUpperCase()), ib = order.indexOf(b.toUpperCase());
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  }

  function getSizesForCurrentCat() {
    const pool = currentCat === 'all' ? items : items.filter(i => i.category === currentCat);
    const all = new Set();
    pool.forEach(i => (i.sizes || []).forEach(s => all.add(s)));
    return [...all].sort(sortSize);
  }

  function buildCatPills() {
    const cats = getCategories();
    if (!cats.length) { catPills.innerHTML = ''; return; }
    catPills.innerHTML = [
      `<button class="pill pill--cat ${currentCat === 'all' ? 'active' : ''}" data-cat="all">All styles</button>`,
      ...cats.map(c => `<button class="pill pill--cat ${currentCat === c ? 'active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`)
    ].join('');
    catPills.querySelectorAll('.pill--cat').forEach(p => {
      p.addEventListener('click', () => {
        catPills.querySelectorAll('.pill--cat').forEach(x => x.classList.remove('active'));
        p.classList.add('active');
        currentCat = p.dataset.cat;
        currentSize = 'all';
        render();
      });
    });
  }

  function buildSizePills() {
    const sizes = getSizesForCurrentCat();
    if (sizes.length < 2) { sizePills.innerHTML = ''; return; }
    sizePills.innerHTML = [
      `<button class="pill pill--size ${currentSize === 'all' ? 'active' : ''}" data-size="all">All sizes</button>`,
      ...sizes.map(s => `<button class="pill pill--size ${currentSize === s ? 'active' : ''}" data-size="${escapeHtml(s)}">${escapeHtml(s)}</button>`)
    ].join('');
    sizePills.querySelectorAll('.pill--size').forEach(p => {
      p.addEventListener('click', () => {
        sizePills.querySelectorAll('.pill--size').forEach(x => x.classList.remove('active'));
        p.classList.add('active');
        currentSize = p.dataset.size;
        render();
      });
    });
  }

  function sizeMatch(item) {
    if (currentSize === 'all') return true;
    const sizes = item.sizes || [];
    if (sizes.includes(currentSize)) return true;
    // also match if any of the item's sizes is a range that contains the selected one
    const target = parseFloat(currentSize);
    if (!isNaN(target)) {
      for (const s of sizes) {
        const range = s.match(/(\d+)\s*[-–]\s*(\d+)/);
        if (range && target >= parseFloat(range[1]) && target <= parseFloat(range[2])) return true;
      }
    }
    return false;
  }

  function render() {
    buildCatPills();
    buildSizePills();

    const filtered = items.filter(item => {
      const availOk = currentAvail === 'all' || (currentAvail === 'sold' ? item.sold : !item.sold);
      const catOk = currentCat === 'all' || item.category === currentCat;
      return availOk && catOk && sizeMatch(item);
    });

    const availCount = items.filter(i => !i.sold).length;
    filterMeta.textContent = `${filtered.length} ${filtered.length === 1 ? 'item' : 'items'} · ${availCount} available`;

    const WA_SVG = `<svg class="wa-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413"/></svg>`;

    gallery.innerHTML = filtered.map(item => {
      const sizesHtml = item.sizes && item.sizes.length
        ? `<div class="size-chips">${item.sizes.map(s => `<span class="size-chip">${escapeHtml(s)}</span>`).join('')}</div>`
        : '';
      const catBadge = item.category
        ? `<span class="badge-cat">${escapeHtml(item.category)}</span>`
        : '';
      const reelHref = item.reel || 'https://www.instagram.com/tonis_jeans_and_tees/';
      return `
      <article class="card ${item.sold ? 'sold' : ''}">
        <div class="card-img-wrap" data-action="zoom" data-id="${item.id}">
          <img class="card-img" src="${item.image}?${IMG_VERSION}" alt="${escapeHtml(item.name)}" loading="lazy">
          ${item.sold ? '<span class="badge-sold">Sold</span>' : ''}
          ${catBadge}
        </div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(item.name)}</h3>
          <p class="card-desc">${escapeHtml(item.description || '')}</p>
          ${sizesHtml}
          <div class="card-price-row">
            <span class="card-price">${fmtPrice(item.price)} <small>· drop-off CBD</small></span>
          </div>
          <div class="card-actions">
            <a class="btn-card" href="${reelHref}" target="_blank" rel="noopener">View on IG</a>
            <a class="btn-card primary" href="${whatsappLink(item)}" target="_blank" rel="noopener" ${item.sold ? 'aria-disabled="true"' : ''}>
              ${WA_SVG} ${item.sold ? 'Sold out' : 'Enquire'}
            </a>
          </div>
        </div>
      </article>`;
    }).join('');
  }

  // Availability pills
  availPills.querySelectorAll('.pill').forEach(p => {
    p.addEventListener('click', () => {
      availPills.querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      currentAvail = p.dataset.avail;
      currentSize = 'all';
      render();
    });
  });

  // Lightbox
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxCap = document.getElementById('lightboxCaption');
  const lightboxClose = document.getElementById('lightboxClose');

  gallery.addEventListener('click', e => {
    const wrap = e.target.closest('[data-action="zoom"]');
    if (!wrap) return;
    const id = wrap.dataset.id;
    const item = items.find(i => i.id === id);
    if (!item) return;
    lightboxImg.src = item.image + '?' + IMG_VERSION;
    lightboxImg.alt = item.name;
    lightboxCap.textContent = `${item.name} · ${fmtPrice(item.price)}${item.sold ? ' · SOLD' : ''}`;
    lightbox.classList.add('open');
    lightbox.setAttribute('aria-hidden', 'false');
  });
  function closeLightbox() {
    lightbox.classList.remove('open');
    lightbox.setAttribute('aria-hidden', 'true');
  }
  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

  // Mobile nav
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');
  navToggle?.addEventListener('click', () => navLinks.classList.toggle('open'));
  navLinks?.querySelectorAll('a').forEach(a => a.addEventListener('click', () => navLinks.classList.remove('open')));

  document.getElementById('year').textContent = new Date().getFullYear();

  await loadData();
  render();
})();
