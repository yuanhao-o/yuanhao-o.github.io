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
  var labelsEl = null;
  var focusActive = false;

  function collectOverlay(scene) {
    scene.traverse(function (o) {
      if (o.isSprite && o.material && o.material.depthTest === false) overlayObjects.push(o);
      if (o.isLine) overlayObjects.push(o);
    });
  }

  function updateFocusIsolation() {
    var cam = window.__camera;
    if (!cam || !bodyRoots.length) return;
    if (!labelsEl || !labelsEl.isConnected) labelsEl = document.getElementById('labels');
    var best = 1e9, target = null;
    for (var i = 0; i < bodyRoots.length; i++) {
      var o = bodyRoots[i].mesh;
      var e = o.matrixWorld.elements;
      var dx = cam.position.x - e[12], dy = cam.position.y - e[13], dz = cam.position.z - e[14];
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz) / Math.max(0.001, Math.abs(o.scale.x));
      if (d < best) { best = d; target = bodyRoots[i]; }
    }
    var on = best < 8;
    if (on === focusActive) return;
    focusActive = on;
    if (labelsEl) labelsEl.style.opacity = on ? '0' : '';
    for (var j = 0; j < overlayObjects.length; j++) overlayObjects[j].visible = !on;
    for (var k = 0; k < bodyRoots.length; k++) {
      bodyRoots[k].root.visible = !on || bodyRoots[k] === target;
    }
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
    earthRef = planets.earth;
    for (var k in planets) {
      var m = planets[k];
      var entry = { mesh: m, rate: SPIN[k], angle: m.rotation.y, drift: 0, cloud: null };
      if (m.parent && m.parent.parent) bodyRoots.push({ mesh: m, root: m.parent.parent });
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

  boot();
})();
