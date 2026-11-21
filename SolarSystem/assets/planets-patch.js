(function () {
  if (!window.THREE || window.__planetsPatched) return;
  window.__planetsPatched = true;

  var STEX = window.__STEX || {};
  var SPIN = {
    mercury: 0.035,
    venus: -0.020,
    earth: 0.025,
    mars: 0.035,
    jupiter: 0.035,
    saturn: 0.035,
    uranus: -0.030,
    neptune: 0.035,
    pluto: 0.030
  };
  var CLOUD_SCALE = 1.006;
  var CLOUD_OPACITY = 0.88;
  var CLOUD_DRIFT = 0.002;
  var TINT = { venus: 0.80, uranus: 0.72 };
  var ATMO_FIX = { neptune: { color: 0x8ec5ff, intensity: 0.85 } };

  function makeTexture(src, srgb) {
    var t = new THREE.Texture();
    t.encoding = srgb ? THREE.sRGBEncoding : THREE.LinearEncoding;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 8;
    var img = new Image();
    img.onload = function () {
      t.image = img;
      t.needsUpdate = true;
    };
    img.src = src;
    return t;
  }

  function findPlanets(scene) {
    var out = {};
    scene.traverse(function (o) {
      if (!o.isMesh || !o.material || !o.material.map) return;
      var img = o.material.map.image;
      if (!img || !img.src) return;
      for (var k in SPIN) {
        if (!out[k] && STEX[k] && img.src === STEX[k]) out[k] = o;
      }
    });
    return out;
  }

  function addClouds(mesh) {
    if (!STEX.earthClouds) return null;
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uClouds: { value: makeTexture(STEX.earthClouds, false) },
        uSunDir: { value: new THREE.Vector3(0, 0, 1) },
        uOpacity: { value: CLOUD_OPACITY }
      },
      vertexShader: [
        'varying vec2 vUv;',
        'varying vec3 vNw;',
        'void main(){',
        '  vUv = uv;',
        '  vNw = normalize(mat3(modelMatrix) * normal);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D uClouds;',
        'uniform vec3 uSunDir;',
        'uniform float uOpacity;',
        'varying vec2 vUv;',
        'varying vec3 vNw;',
        'void main(){',
        '  float a = texture2D(uClouds, vUv).r;',
        '  float ndl = dot(normalize(vNw), normalize(uSunDir));',
        '  float day = smoothstep(-0.12, 0.28, ndl);',
        '  float shade = 0.16 + 0.84 * day;',
        '  float alpha = a * uOpacity * mix(0.04, 1.0, day);',
        '  gl_FragColor = vec4(vec3(shade) * vec3(1.0, 0.99, 0.96), alpha);',
        '}'
      ].join('\n'),
      transparent: true,
      depthWrite: false
    });
    var cloud = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 80), mat);
    cloud.scale.setScalar(CLOUD_SCALE);
    cloud.renderOrder = 3;
    cloud.name = '__earth_clouds';
    mesh.add(cloud);
    return cloud;
  }

  function fixAtmo(mesh, key) {
    var cfg = ATMO_FIX[key];
    if (!cfg || !mesh.parent) return false;
    var kids = mesh.parent.children;
    for (var i = 0; i < kids.length; i++) {
      var m = kids[i].material;
      if (kids[i] === mesh || !m || m.type !== 'ShaderMaterial') continue;
      var u = m.uniforms;
      if (!u || !u.uColor || !u.uIntensity) continue;
      u.uColor.value.setHex(cfg.color);
      u.uIntensity.value = cfg.intensity;
      return true;
    }
    return false;
  }

  function replaceSaturnRing(mesh) {
    if (!STEX.saturnRing) return false;
    var group = mesh.parent;
    var ring = null;
    for (var i = 0; i < group.children.length; i++) {
      var c = group.children[i];
      if (c !== mesh && c.geometry && c.geometry.type === 'RingGeometry') {
        ring = c;
        break;
      }
    }
    if (!ring) return false;

    var p = ring.geometry.parameters;
    var pos = ring.geometry.attributes.position;
    var uv = ring.geometry.attributes.uv;
    var span = p.outerRadius - p.innerRadius;
    for (var j = 0; j < pos.count; j++) {
      var x = pos.getX(j);
      var y = pos.getY(j);
      var r = Math.sqrt(x * x + y * y);
      uv.setXY(j, (r - p.innerRadius) / span, 0.5);
    }
    uv.needsUpdate = true;

    if (ring.material.dispose) ring.material.dispose();
    ring.material = new THREE.MeshStandardMaterial({
      map: makeTexture(STEX.saturnRing, true),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      alphaTest: 0.02
    });
    ring.name = '__saturn_ring';
    return true;
  }

  var entries = [];
  var last = 0;
  var earthRef = null;
  var tmpVec = new THREE.Vector3();
  var SEG_W = 128, SEG_H = 80;
  var overlayObjects = [];
  var bodyRoots = [];
  var meta = {};
  var labelsEl = null;
  var ISOLATE_AT = 10;
  var MIN_PICK_PX = 14;
  var focusKey = '';
  var _wp = new THREE.Vector3();
  var _ws = new THREE.Vector3();
  var _pv = new THREE.Vector3();
  var _pq = new THREE.Vector3();
  var _ps = new THREE.Vector3();

  function collectOverlay(scene) {
    scene.traverse(function (o) {
      if (o.isSprite && o.material && o.material.depthTest === false) overlayObjects.push(o);
      if (o.isLine) overlayObjects.push(o);
    });
  }

  function isShown(o) {
    while (o) {
      if (o.visible === false) return false;
      o = o.parent;
    }
    return true;
  }

  function bodyRadius(e) {
    e.mesh.getWorldScale(_ws);
    var g = e.mesh.geometry;
    var r = (g && g.parameters && g.parameters.radius) || 1;
    return Math.abs(r * _ws.x);
  }

  function bodyRatio(e) {
    var cam = window.__camera;
    if (!cam) return 1e9;
    e.mesh.getWorldPosition(_wp);
    return cam.position.distanceTo(_wp) / Math.max(bodyRadius(e), 1e-4);
  }

  function contains(root, obj) {
    while (obj) {
      if (obj === root) return true;
      obj = obj.parent;
    }
    return false;
  }

  function panelTarget() {
    var panel = document.getElementById('panel');
    if (!panel || !panel.classList.contains('open')) return null;
    var el = document.getElementById('pName');
    return { zh: el ? el.textContent.replace(/\s+/g, '') : '' };
  }

  function updateFocusIsolation() {
    var f = panelTarget();
    var on = false, keep = [], best = 1e9, i, id;
    if (f) {
      var sel = null;
      for (id in meta) {
        if (meta[id].data.zh === f.zh) { sel = meta[id].obj; break; }
      }
      for (i = 0; i < bodyRoots.length; i++) {
        var r = bodyRatio(bodyRoots[i]);
        if (r < best) best = r;
        if (sel && contains(bodyRoots[i].root, sel)) keep.push(bodyRoots[i]);
        else if (!sel && f.zh && bodyRoots[i].zh === f.zh) keep.push(bodyRoots[i]);
      }
      for (i = 0; i < keep.length; i++) best = Math.min(best, bodyRatio(keep[i]));
      on = best < ISOLATE_AT;
    }
    var key = (on ? '1' : '0') + '|' + (on ? keep.map(function (e) { return e.zh; }).join(',') : '');
    if (key === focusKey) return;
    focusKey = key;
    if (!labelsEl || !labelsEl.isConnected) labelsEl = document.getElementById('labels');
    if (labelsEl) labelsEl.style.opacity = on ? '0' : '';
    for (i = 0; i < overlayObjects.length; i++) {
      var o = overlayObjects[i];
      if (on) {
        if (o.__wasVisible === undefined) o.__wasVisible = o.visible;
        o.visible = false;
      } else if (o.__wasVisible !== undefined) {
        o.visible = o.__wasVisible;
        delete o.__wasVisible;
      }
    }
    for (i = 0; i < bodyRoots.length; i++) {
      var e = bodyRoots[i];
      e.root.visible = !on || keep.indexOf(e) >= 0;
    }
  }

  function visualRadius(hit) {
    if (hit.__visR) return hit.__visR;
    var hitR = (hit.geometry && hit.geometry.parameters && hit.geometry.parameters.radius) || 1;
    var best = 0, p = hit.parent;
    if (p) {
      p.traverse(function (o) {
        if (o === hit || !o.isMesh || !o.geometry) return;
        var par = o.geometry.parameters;
        if (!par || par.radius === undefined || par.radius >= hitR) return;
        if (par.radius > best) best = par.radius;
      });
    }
    hit.__visR = best > 0 ? best : hitR;
    return hit.__visR;
  }

  function raySphere(o, d, c, r) {
    var ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
    var b = ox * d.x + oy * d.y + oz * d.z;
    var disc = b * b - (ox * ox + oy * oy + oz * oz - r * r);
    if (disc < 0) return -1;
    var sq = Math.sqrt(disc);
    if (-b - sq > 0) return -b - sq;
    if (-b + sq > 0) return -b + sq;
    return -1;
  }

  function pickBody(objs, ray) {
    var cam = ray.camera || window.__camera;
    var ndc = ray.__ndc;
    if (!cam || !ndc) return null;
    var W = window.innerWidth, H = window.innerHeight;
    var tanHalf = Math.tan(cam.fov * Math.PI / 360);
    var O = ray.ray.origin, D = ray.ray.direction;
    var front = null, near = null;
    for (var i = 0; i < objs.length; i++) {
      var o = objs[i];
      if (!o.geometry || !o.geometry.parameters) continue;
      if (!isShown(o)) continue;
      o.getWorldPosition(_pv);
      _pq.copy(_pv).applyMatrix4(cam.matrixWorldInverse);
      if (_pq.z > -1e-3) continue;
      var d = cam.position.distanceTo(_pv);
      o.getWorldScale(_ps);
      var sc = Math.abs(_ps.x);
      var hitR = (o.geometry.parameters.radius || 1) * sc;
      var visR = visualRadius(o) * sc;
      var t = raySphere(O, D, _pv, visR);
      if (t > 0) {
        if (!front || t < front.d) front = { o: o, d: t, p: _pv.clone() };
        continue;
      }
      _pq.copy(_pv).project(cam);
      var px = Math.sqrt(Math.pow((_pq.x - ndc.x) * W * 0.5, 2) + Math.pow((_pq.y - ndc.y) * H * 0.5, 2));
      var pxHit = (hitR / Math.sqrt(Math.max(d * d - hitR * hitR, 1e-6))) / tanHalf * (H * 0.5);
      var score = px / Math.max(pxHit, MIN_PICK_PX);
      if (score <= 1 && (!near || score < near.score)) near = { o: o, d: d, p: _pv.clone(), score: score };
    }
    var win = front || near;
    if (!win) return null;
    return [{ object: win.o, distance: win.d, point: win.p, face: null, faceIndex: 0 }];
  }

  function patchPicking() {
    var proto = THREE.Raycaster.prototype;
    if (proto.__bpPick) return;
    proto.__bpPick = true;
    var origSet = proto.setFromCamera;
    var origHit = proto.intersectObjects;
    proto.setFromCamera = function (coords) {
      this.__ndc = coords;
      return origSet.apply(this, arguments);
    };
    proto.intersectObjects = function (objects) {
      var res = origHit.apply(this, arguments);
      if (!objects || !objects.length || !objects[0] || !objects[0].userData || !objects[0].userData.body) return res;
      if (!this.__ndc) return res;
      return pickBody(objects, this) || res;
    };
  }

  function upgradeGeometry(o) {
    var g = o.geometry;
    if (!g || (g.type || '').indexOf('SphereGeometry') < 0) return false;
    var p = g.parameters || {};
    if (p.radius === undefined || p.radius > 1000) return false;
    if ((p.widthSegments || 0) >= SEG_W) return false;
    var ng = new THREE.SphereGeometry(
      p.radius, SEG_W, SEG_H,
      p.phiStart || 0,
      p.phiLength === undefined ? Math.PI * 2 : p.phiLength,
      p.thetaStart || 0,
      p.thetaLength === undefined ? Math.PI : p.thetaLength
    );
    o.geometry = ng;
    if (g.dispose) g.dispose();
    return true;
  }

  function upgradeScene(scene) {
    var n = 0;
    scene.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.visible) return;
      var m = o.material;
      if (!m || m.visible === false) return;
      if (m.transparent && m.opacity === 0) return;
      if (upgradeGeometry(o)) n++;
    });
    return n;
  }

  function layoutDock(noAnim) {
    var dock = document.getElementById('dock');
    var panel = document.getElementById('panel');
    if (!dock || !panel) return;
    dock.style.maxWidth = '';
    dock.style.flexWrap = '';
    var open = document.documentElement.getAttribute('data-panel-open') === '1';
    if (!open) { dock.style.transform = ''; return; }
    var cs = getComputedStyle(panel);
    var pw = parseFloat(cs.width) || 0;
    var rg = parseFloat(cs.right);
    if (isNaN(rg)) rg = 22;
    var panelLeft = window.innerWidth - rg - pw;
    var avail = panelLeft - 44;
    if (avail < 320 || pw <= 0) { dock.style.transform = ''; return; }
    if (dock.offsetWidth > avail) {
      dock.style.maxWidth = Math.round(avail) + 'px';
      dock.style.flexWrap = 'wrap';
    }
    var dx = Math.round(panelLeft / 2 - window.innerWidth / 2);
    if (noAnim) dock.style.transition = 'none';
    dock.style.transform = 'translateX(calc(-50% + ' + dx + 'px))';
    if (noAnim) {
      void dock.offsetWidth;
      requestAnimationFrame(function () { dock.style.transition = ''; });
    }
  }

  function syncPanelState() {
    var panel = document.getElementById('panel');
    if (!panel) return false;
    var first = true;
    var apply = function () {
      if (panel.classList.contains('open')) document.documentElement.setAttribute('data-panel-open', '1');
      else document.documentElement.removeAttribute('data-panel-open');
      layoutDock(first);
      first = false;
    };
    apply();
    window.addEventListener('resize', function () { layoutDock(true); });
    if (window.MutationObserver) {
      new MutationObserver(apply).observe(panel, { attributes: true, attributeFilter: ['class'] });
    }
    return true;
  }

  function step() {
    var now = window.performance && performance.now ? performance.now() : Date.now();
    if (!last) last = now;
    var dt = Math.min(0.06, (now - last) / 1000);
    last = now;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      e.angle += e.rate * dt;
      e.mesh.rotation.y = e.angle;
      if (e.cloud) {
        e.drift += CLOUD_DRIFT * dt;
        e.cloud.rotation.y = e.drift;
      }
    }
    if (earthRef) {
      earthRef.getWorldPosition(tmpVec);
      if (tmpVec.lengthSq() > 1e-8) {
        tmpVec.normalize().negate();
        for (var j = 0; j < entries.length; j++) {
          var c = entries[j].cloud;
          if (c) c.material.uniforms.uSunDir.value.copy(tmpVec);
        }
      }
    }
    updateFocusIsolation();
  }

  function boot() {
    var scene = (window.__scenes || [])[0] || window.__scene;
    if (!scene) return setTimeout(boot, 300);
    var planets = findPlanets(scene);
    if (!planets.earth) return setTimeout(boot, 300);

    var upgraded = upgradeScene(scene);
    syncPanelState();
    collectOverlay(scene);

    var names = [];
    scene.traverse(function (o) {
      if (o.userData && o.userData.body && o.userData.body.id) {
        var bid = o.userData.body.id;
        if (!meta[bid]) meta[bid] = { data: o.userData.body, obj: o };
      }
    });
    earthRef = planets.earth;
    for (var k in planets) {
      var m = planets[k];
      var entry = { mesh: m, rate: SPIN[k], angle: m.rotation.y, drift: 0, cloud: null };
      if (m.parent && m.parent.parent) {
        bodyRoots.push({ mesh: m, root: m.parent.parent, zh: meta[k] ? meta[k].data.zh : '' });
      }
      if (TINT[k] && m.material && m.material.color) m.material.color.setScalar(TINT[k]);
      fixAtmo(m, k);
      if (k === 'earth') entry.cloud = addClouds(m);
      entries.push(entry);
      names.push(k);
    }
    var ring = planets.saturn ? replaceSaturnRing(planets.saturn) : false;
    window.__planetsInfo = { bodies: names.sort(), clouds: !!(planets.earth && STEX.earthClouds), ring: ring, upgraded: upgraded };
  }

  window.__earthFrame = function (scene, camera) {
    if (window.__earthTick) window.__earthTick(scene, camera);
    step();
  };

  patchPicking();
  boot();
})();
