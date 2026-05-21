/* outcode-choropleth.js — Sam Dooley methodology Layer 1
 *
 * Reusable UK outcode choropleth. Drop-in for any brand-hub page.
 *
 * Requires:
 *   - Leaflet 1.9+ already loaded on the page
 *   - <div id="outcode-map"></div>     (the map container)
 *   - <div id="outcode-controls"></div> (the control panel — buttons rendered into here)
 *   - geo/uk-outcodes.geojson           (2,736 outcode polygons, 2.3 MB / ~560 KB gz)
 *   - outcode-metrics.json              (per-outcode metrics for the brand or national)
 *
 * Boot:
 *   OutcodeChoropleth.init({
 *     mapElementId: 'outcode-map',
 *     controlsElementId: 'outcode-controls',
 *     metricsUrl: 'outcode-metrics.json',     // brand-scoped if inside a brand hub folder
 *     geoUrl: '/brand-hub/geo/uk-outcodes.geojson',
 *     brandColor: '#c9a35c',
 *     onOutcodeSelected: function(outcode){ ... }   // hard-rule click-to-filter
 *   });
 */

(function (global) {
  'use strict';

  // Mode definitions — each is independent and self-contained
  var MODES = {
    'presence': {
      label: 'Brand presence',
      legend: 'Outcodes where the brand has ≥1 office.',
      dot: '#c9a35c',
      color: function (m, ctx) {
        if (!m || !m.office_count) return null; // no fill = no data
        return ctx.brandColor;
      },
      opacity: function (m) {
        if (!m || !m.office_count) return 0;
        // Stronger opacity for more offices in that outcode
        return Math.min(0.85, 0.30 + 0.08 * Math.log2(1 + m.office_count));
      },
      scale: null
    },
    'reputation': {
      label: 'Reputation score',
      legend: 'Average reputation score across all brand offices in the outcode (0–100).',
      dot: '#22c55e',
      color: function (m) {
        if (!m || m.avg_rep_score == null) return null;
        return interpolateRYG(m.avg_rep_score / 100);
      },
      opacity: function (m) {
        return (m && m.avg_rep_score != null) ? 0.78 : 0;
      },
      scale: { from: '#dc2626', mid: '#f59e0b', to: '#16a34a', labels: ['0', '50', '100'] }
    },
    'volume': {
      label: 'Review volume',
      legend: 'Total reviews across all brand offices in the outcode.',
      dot: '#dfc07a',
      color: function (m, ctx) {
        if (!m || !m.total_reviews) return null;
        // Log scale because review counts are heavy-tailed
        var t = Math.min(1, Math.log10(1 + m.total_reviews) / Math.log10(1 + ctx._maxReviews));
        return interpolateGold(t);
      },
      opacity: function (m) {
        return (m && m.total_reviews) ? 0.78 : 0;
      },
      scale: { from: '#3d2c12', mid: '#a07b30', to: '#dfc07a', labels: ['low', '', 'high'] }
    },
    'rag': {
      label: 'RAG distribution',
      legend: 'Outcode dominant RAG status (green = mostly healthy, red = mostly stale).',
      dot: '#ef4444',
      color: function (m) {
        if (!m || !m.rag_breakdown) return null;
        var rb = m.rag_breakdown;
        var total = (rb.GREEN || 0) + (rb.AMBER || 0) + (rb.RED || 0);
        if (!total) return null;
        var greenRatio = (rb.GREEN || 0) / total;
        var redRatio = (rb.RED || 0) / total;
        if (redRatio >= 0.5) return '#ef4444';
        if (greenRatio >= 0.6) return '#10b981';
        return '#f59e0b';
      },
      opacity: function (m) {
        return (m && m.office_count) ? 0.78 : 0;
      },
      scale: null,
      swatches: [
        { color: '#10b981', label: '≥60% Green' },
        { color: '#f59e0b', label: 'Mixed' },
        { color: '#ef4444', label: '≥50% Red' }
      ]
    }
  };

  // ----- colour helpers -----
  function hex2rgb(h) {
    h = h.replace('#', '');
    return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
  }
  function rgb2hex(r, g, b) {
    return '#' + [r, g, b].map(function (v) { return Math.round(v).toString(16).padStart(2, '0'); }).join('');
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpHex(a, b, t) {
    var ra = hex2rgb(a), rb = hex2rgb(b);
    return rgb2hex(lerp(ra[0], rb[0], t), lerp(ra[1], rb[1], t), lerp(ra[2], rb[2], t));
  }
  function interpolateRYG(t) {
    // 0 = red, 0.5 = amber, 1 = green
    t = Math.max(0, Math.min(1, t));
    if (t < 0.5) return lerpHex('#dc2626', '#f59e0b', t * 2);
    return lerpHex('#f59e0b', '#16a34a', (t - 0.5) * 2);
  }
  function interpolateGold(t) {
    t = Math.max(0, Math.min(1, t));
    if (t < 0.5) return lerpHex('#3d2c12', '#a07b30', t * 2);
    return lerpHex('#a07b30', '#dfc07a', (t - 0.5) * 2);
  }

  function fmt(n) {
    if (n == null || isNaN(n)) return '\u2014';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return Math.round(n).toString();
  }

  function OutcodeChoropleth() {}

  OutcodeChoropleth.prototype.init = function (opts) {
    var self = this;
    self.opts = Object.assign({
      mapElementId: 'outcode-map',
      controlsElementId: 'outcode-controls',
      metricsUrl: 'outcode-metrics.json',
      geoUrl: '/brand-hub/geo/uk-outcodes.geojson',
      brandColor: '#c9a35c',
      defaultMode: 'reputation',
      onOutcodeSelected: null,
      modes: ['presence', 'reputation', 'volume', 'rag']
    }, opts || {});
    self._currentMode = self.opts.defaultMode;
    self._layer = null;
    self._selected = null;

    self._buildControls();
    self._loadData().then(function () { self._renderMap(); });
  };

  OutcodeChoropleth.prototype._buildControls = function () {
    var self = this;
    var host = document.getElementById(self.opts.controlsElementId);
    if (!host) return;

    var modesHtml = '<div><h3>Visualisation</h3><div class="outcode-mode-list" id="oc-mode-list">' +
      self.opts.modes.map(function (k) {
        var m = MODES[k];
        if (!m) return '';
        return '<button class="outcode-mode-btn' + (k === self._currentMode ? ' active' : '') +
          '" data-mode="' + k + '"><span class="dot" style="background:' + m.dot + '"></span>' + m.label + '</button>';
      }).join('') + '</div></div>';

    var legendHtml = '<div><h3>Legend</h3><div class="outcode-legend" id="oc-legend"></div></div>';

    var footHtml = '<div class="outcode-footer-note" id="oc-footer">2,736 UK outcodes · click any patch to filter the leaderboard below · boundaries approximate (Wikipedia/Royal Mail-derived).</div>';

    host.innerHTML = modesHtml + legendHtml + footHtml;

    host.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.outcode-mode-btn');
      if (!btn) return;
      var mode = btn.dataset.mode;
      if (!MODES[mode] || mode === self._currentMode) return;
      self._currentMode = mode;
      host.querySelectorAll('.outcode-mode-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.mode === mode);
      });
      self._restyle();
      self._renderLegend();
    });
  };

  OutcodeChoropleth.prototype._renderLegend = function () {
    var self = this;
    var el = document.getElementById('oc-legend');
    if (!el) return;
    var m = MODES[self._currentMode];
    var html = '<div style="margin-bottom:8px;">' + m.legend + '</div>';
    if (m.scale) {
      html += '<div class="scale">' +
        '<span style="background:' + m.scale.from + '"></span>' +
        '<span style="background:linear-gradient(90deg,' + m.scale.from + ',' + (m.scale.mid || m.scale.to) + ');"></span>' +
        '<span style="background:linear-gradient(90deg,' + (m.scale.mid || m.scale.from) + ',' + m.scale.to + ');"></span>' +
        '<span style="background:' + m.scale.to + '"></span>' +
        '</div><div class="scale-labels"><span>' + m.scale.labels[0] + '</span><span>' + m.scale.labels[1] + '</span><span>' + m.scale.labels[2] + '</span></div>';
    } else if (m.swatches) {
      html += m.swatches.map(function (s) {
        return '<div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px;">' +
          '<span style="width:14px;height:14px;border-radius:3px;background:' + s.color + ';"></span>' + s.label + '</div>';
      }).join('');
    }
    el.innerHTML = html;
  };

  OutcodeChoropleth.prototype._loadData = function () {
    var self = this;
    return Promise.all([
      fetch(self.opts.geoUrl, { cache: 'force-cache' }).then(function (r) { return r.json(); }),
      fetch(self.opts.metricsUrl, { cache: 'no-cache' }).then(function (r) { return r.json(); })
    ]).then(function (results) {
      self._geo = results[0];
      self._metrics = results[1];
      // Pre-compute global max for log-scale visualisations
      var maxR = 0;
      var m = self._metrics && self._metrics.metrics ? self._metrics.metrics : {};
      Object.keys(m).forEach(function (k) {
        if (m[k].total_reviews > maxR) maxR = m[k].total_reviews;
      });
      self._ctx = { brandColor: self.opts.brandColor, _maxReviews: maxR };
    }).catch(function (err) {
      console.error('OutcodeChoropleth load failed', err);
    });
  };

  OutcodeChoropleth.prototype._renderMap = function () {
    var self = this;
    if (typeof L === 'undefined') {
      setTimeout(function () { self._renderMap(); }, 200);
      return;
    }
    var el = document.getElementById(self.opts.mapElementId);
    if (!el) return;

    self._map = L.map(self.opts.mapElementId, {
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: true
    }).setView([54.6, -3.4], 6);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 12,
      minZoom: 5,
      attribution: '© OpenStreetMap, © CARTO · Outcode boundaries © Royal Mail/Wikipedia'
    }).addTo(self._map);

    self._layer = L.geoJSON(self._geo, {
      style: function (feat) { return self._styleFor(feat); },
      onEachFeature: function (feat, layer) {
        layer.on({
          mouseover: function (e) {
            var l = e.target;
            l.setStyle({ weight: 2, color: '#ffffff', opacity: 1 });
            l.bringToFront();
          },
          mouseout: function (e) {
            self._layer.resetStyle(e.target);
            if (self._selected && self._selected === feat.id) {
              e.target.setStyle({ weight: 2.5, color: '#dfc07a', opacity: 1 });
              e.target.bringToFront();
            }
          },
          click: function (e) {
            self._onPolygonClick(feat, e);
          }
        });
        layer.bindPopup(self._popupHtml(feat), { className: 'outcode-popup', maxWidth: 260 });
      }
    }).addTo(self._map);

    self._renderLegend();

    // Bounds: shrink to areas where the brand actually has presence
    self._fitToData();
  };

  OutcodeChoropleth.prototype._styleFor = function (feat) {
    var self = this;
    var m = self._metrics.metrics[feat.id];
    var mode = MODES[self._currentMode];
    var fill = mode.color(m, self._ctx);
    var op = mode.opacity(m);
    return {
      fillColor: fill || '#1a2a44',
      fillOpacity: op,
      weight: 0.4,
      color: 'rgba(255,255,255,0.18)',
      opacity: 0.6
    };
  };

  OutcodeChoropleth.prototype._restyle = function () {
    var self = this;
    if (!self._layer) return;
    self._layer.eachLayer(function (l) { l.setStyle(self._styleFor(l.feature)); });
  };

  OutcodeChoropleth.prototype._popupHtml = function (feat) {
    var self = this;
    var m = self._metrics.metrics[feat.id];
    var outcode = feat.id;
    var areaName = feat.properties && feat.properties.name ? feat.properties.name : '';
    var brandList = '';
    if (m && m.brand_breakdown) {
      brandList = Object.keys(m.brand_breakdown).sort(function (a, b) {
        return m.brand_breakdown[b] - m.brand_breakdown[a];
      }).slice(0, 4).map(function (b) {
        return b + ' &times;' + m.brand_breakdown[b];
      }).join(', ');
    }
    var html = '<div class="pc">' + outcode + '</div>';
    if (areaName && areaName !== outcode) {
      html += '<div style="font-size:11px;color:rgba(255,255,255,0.55);margin-top:-4px;margin-bottom:8px;">' + areaName.replace(outcode, '').replace(/[()]/g, '').trim() + '</div>';
    }
    if (!m) {
      html += '<div style="font-style:italic;color:rgba(255,255,255,0.55);font-size:12px;">No brand office in this outcode.</div>' +
        '<div class="pop-cta">Whitespace opportunity.</div>';
      return html;
    }
    html += '<div class="row"><span>Offices</span><b>' + m.office_count + '</b></div>';
    if (m.total_reviews) html += '<div class="row"><span>Total reviews</span><b>' + fmt(m.total_reviews) + '</b></div>';
    if (m.avg_rep_score != null) html += '<div class="row"><span>Avg score</span><b>' + m.avg_rep_score + '</b></div>';
    if (m.avg_rating != null) html += '<div class="row"><span>Avg rating</span><b>' + m.avg_rating.toFixed(2) + '★</b></div>';
    if (m.avg_reply_rate != null) html += '<div class="row"><span>Avg reply rate</span><b>' + Math.round(m.avg_reply_rate) + '%</b></div>';
    if (brandList) html += '<div class="row" style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.10);padding-top:6px;"><span style="font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,0.55);">Brands</span></div>' +
      '<div style="font-size:11.5px;color:rgba(255,255,255,0.78);">' + brandList + '</div>';
    if (m.champion) {
      html += '<div class="pop-champion"><div class="lbl">Outcode champion</div><div class="name">' + m.champion.name + '</div>' +
        '<div style="font-size:11px;color:rgba(255,255,255,0.65);">Score ' + m.champion.rep_score + ' · ' + (m.champion.rating ? m.champion.rating.toFixed(2) + '★' : '') + ' · ' + fmt(m.champion.total_reviews) + ' reviews</div></div>';
    }
    html += '<div class="pop-cta">Click to filter the leaderboard below.</div>';
    return html;
  };

  OutcodeChoropleth.prototype._onPolygonClick = function (feat, e) {
    var self = this;
    self._selected = feat.id;
    // Highlight the selected polygon
    self._layer.eachLayer(function (l) {
      if (l.feature.id === feat.id) {
        l.setStyle({ weight: 2.5, color: '#dfc07a', opacity: 1 });
        l.bringToFront();
      } else {
        self._layer.resetStyle(l);
      }
    });
    // Dispatch the custom event
    var ev = new CustomEvent('outcode-selected', { detail: { outcode: feat.id } });
    document.dispatchEvent(ev);
    // Direct callback
    if (typeof self.opts.onOutcodeSelected === 'function') {
      self.opts.onOutcodeSelected(feat.id);
    }
  };

  OutcodeChoropleth.prototype.clearSelection = function () {
    var self = this;
    self._selected = null;
    if (self._layer) self._layer.eachLayer(function (l) { self._layer.resetStyle(l); });
    self._restyle();
  };

  OutcodeChoropleth.prototype._fitToData = function () {
    var self = this;
    var bounds = null;
    self._layer.eachLayer(function (l) {
      var m = self._metrics.metrics[l.feature.id];
      if (!m || !m.office_count) return;
      var b = l.getBounds();
      bounds = bounds ? bounds.extend(b) : b;
    });
    if (bounds && bounds.isValid()) {
      self._map.fitBounds(bounds, { padding: [30, 30], maxZoom: 11 });
    }
  };

  // Expose singleton with chainable init
  global.OutcodeChoropleth = new OutcodeChoropleth();
})(window);
