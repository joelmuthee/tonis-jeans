// Toni's Jeans & Tees - frontend catalog
const IMG_VERSION = 'v1';
const API_BASE = 'https://tonisjeansandtees-api.stawisystems.workers.dev';
(async function() {
  const gallery = document.getElementById('gallery');
  const filterMeta = document.getElementById('filterMeta');
  const availPills = document.getElementById('availPills');
  const catPills = document.getElementById('catPills');
  const sizePills = document.getElementById('sizePills');
  const PAGE_SIZE = 15;
  let items = [];
  let settings = {};
  let currentAvail = 'all';
  let currentCat = 'all';
  let currentSize = 'all';
  let currentPage = 1;

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

  // Stock helpers - read the new schema (stock {} + sales []) with graceful fallback to legacy sizes[].
  function totalStock(item) {
    if (item.stock && Object.keys(item.stock).length) {
      return Object.values(item.stock).reduce((s, q) => s + (Number(q) || 0), 0);
    }
    // Legacy: assume 1 unit per listed size
    return (item.sizes || []).length;
  }
  function availSizes(item) {
    if (item.stock && Object.keys(item.stock).length) {
      const hasSales = (item.sales || []).length > 0;
      // Before any recorded sale, show every configured size. After sales begin, hide zero-stock sizes.
      const keys = hasSales
        ? Object.entries(item.stock).filter(([, q]) => q > 0).map(([s]) => s)
        : Object.keys(item.stock);
      return keys.filter(s => s !== 'One Size').sort(sortSize);
    }
    return (item.sizes || []).slice().sort(sortSize);
  }
  function isSoldOut(item) {
    // Legacy fallback
    if (typeof item.sold === 'boolean' && (!item.stock || !Object.keys(item.stock).length)) return item.sold;
    // New schema: every configured size at 0 AND at least one sale recorded
    if (!item.stock || !Object.keys(item.stock).length) return false;
    const allZero = Object.values(item.stock).every(q => (q || 0) === 0);
    if (!allZero) return false;
    return (item.sales || []).length > 0;
  }

  function whatsappLink(item) {
    const phone = (settings.whatsappNumber || '254721623937');
    const avail = availSizes(item);
    const sizePart = avail.length ? ` (sizes: ${avail.join(', ')})` : '';
    const link = item.reel || item.instagramUrl || 'https://www.instagram.com/tonis_jeans_and_tees/';
    const msg = `Hi Toni! I'd like to enquire about the *${item.name}*${sizePart} (${fmtPrice(item.price)}) from your catalog.\n\nLink: ${link}`;
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
    pool.forEach(i => availSizes(i).forEach(s => all.add(s)));
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
        currentPage = 1;
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
        currentPage = 1;
        render();
      });
    });
  }

  function sizeMatch(item) {
    if (currentSize === 'all') return true;
    const sizes = availSizes(item);
    if (sizes.includes(currentSize)) return true;
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
      const soldOut = isSoldOut(item);
      const availOk = currentAvail === 'all' || (currentAvail === 'sold' ? soldOut : !soldOut);
      const catOk = currentCat === 'all' || item.category === currentCat;
      return availOk && catOk && sizeMatch(item);
    });

    const availCount = items.filter(i => !isSoldOut(i)).length;
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const visible = filtered.slice(start, end);
    const showing = visible.length ? `${start + 1}–${start + visible.length}` : '0';
    filterMeta.textContent = `Showing ${showing} of ${filtered.length} · ${availCount} available`;

    const WA_SVG = `<svg class="wa-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413"/></svg>`;

    gallery.innerHTML = visible.map(item => {
      const soldOut = isSoldOut(item);
      const avail = availSizes(item);
      const sizesHtml = avail.length
        ? `<div class="size-chips">${avail.map(s => `<span class="size-chip">${escapeHtml(s)}</span>`).join('')}</div>`
        : '';
      const catBadge = item.category
        ? `<span class="badge-cat">${escapeHtml(item.category)}</span>`
        : '';
      const units = totalStock(item);
      const lowStock = !soldOut && units >= 1 && units <= 3;
      return `
      <article class="card ${soldOut ? 'sold' : ''}">
        <div class="card-img-wrap" data-action="zoom" data-id="${item.id}">
          <img class="card-img" src="${item.image}?${IMG_VERSION}" alt="${escapeHtml(item.name)}" loading="lazy">
          ${soldOut ? '<span class="badge-sold">Sold out</span>' : ''}
          ${lowStock ? `<span class="badge-low">Only ${units} left</span>` : ''}
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
            <a class="btn-card primary" href="${whatsappLink(item)}" target="_blank" rel="noopener" ${soldOut ? 'aria-disabled="true"' : ''}>
              ${WA_SVG} ${soldOut ? 'Sold out' : 'Enquire'}
            </a>
          </div>
        </div>
      </article>`;
    }).join('');

    // Numbered pagination
    const oldPager = document.getElementById('pagerWrap');
    if (oldPager) oldPager.remove();
    if (totalPages > 1) {
      const wrap = document.createElement('div');
      wrap.id = 'pagerWrap';
      wrap.className = 'pager-wrap';
      const pages = pageRange(currentPage, totalPages);
      const btn = (label, page, opts = {}) => {
        const cls = ['pager-btn'];
        if (opts.active) cls.push('active');
        if (opts.disabled) cls.push('disabled');
        if (opts.ellipsis) cls.push('ellipsis');
        const dataPage = opts.disabled || opts.ellipsis ? '' : ` data-page="${page}"`;
        return `<button class="${cls.join(' ')}"${dataPage}${opts.disabled ? ' disabled' : ''}>${label}</button>`;
      };
      const html = [
        btn('‹', currentPage - 1, { disabled: currentPage === 1 }),
        ...pages.map(p => p === '…' ? btn('…', null, { ellipsis: true }) : btn(p, p, { active: p === currentPage })),
        btn('›', currentPage + 1, { disabled: currentPage === totalPages }),
      ].join('');
      wrap.innerHTML = html;
      gallery.parentNode.insertBefore(wrap, gallery.nextSibling);
      wrap.querySelectorAll('.pager-btn[data-page]').forEach(b => {
        b.addEventListener('click', () => {
          const p = parseInt(b.dataset.page, 10);
          if (!isNaN(p) && p >= 1 && p <= totalPages && p !== currentPage) {
            currentPage = p;
            render();
            document.getElementById('shop').scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        });
      });
    }
  }

  function pageRange(cur, total) {
    if (total <= 7) return Array.from({length: total}, (_, i) => i + 1);
    const pages = [1];
    if (cur > 3) pages.push('…');
    for (let p = Math.max(2, cur - 1); p <= Math.min(total - 1, cur + 1); p++) pages.push(p);
    if (cur < total - 2) pages.push('…');
    pages.push(total);
    return pages;
  }

  // Availability pills
  availPills.querySelectorAll('.pill').forEach(p => {
    p.addEventListener('click', () => {
      availPills.querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      currentAvail = p.dataset.avail;
      currentSize = 'all';
      currentPage = 1;
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
    lightboxCap.textContent = `${item.name} · ${fmtPrice(item.price)}${isSoldOut(item) ? ' · SOLD' : ''}`;
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
  const navClose = document.getElementById('navClose');
  function closeNav() { navLinks?.classList.remove('open'); document.body.style.overflow = ''; }
  function openNav() { navLinks?.classList.add('open'); document.body.style.overflow = 'hidden'; }
  navToggle?.addEventListener('click', () => navLinks.classList.contains('open') ? closeNav() : openNav());
  navClose?.addEventListener('click', closeNav);
  navLinks?.querySelectorAll('a').forEach(a => a.addEventListener('click', closeNav));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && navLinks?.classList.contains('open')) closeNav(); });

  document.getElementById('year').textContent = new Date().getFullYear();

  await loadData();
  render();
})();
