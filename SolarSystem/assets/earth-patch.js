(function () {
  var STEX = window.__STEX || {};
  var earth = null, U = null;

  function nightTexture() {
    var t = new THREE.Texture();
    t.encoding = THREE.sRGBEncoding;
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = 8;
    var img = new Image();
    img.onload = function () { t.image = img; t.needsUpdate = true; };
    img.src = STEX.earthNight;
    return t;
  }

  var VERT = [
    'varying vec2 vUv;',
    'varying vec3 vNw;',
    'void main(){',
    '  vUv = uv;',
    '  vNw = normalize(mat3(modelMatrix) * normal);',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');

  function nightMaskGLSL() {
    return [
      'vec3 N = normalize(vNw);',
      'vec3 L = normalize(uSunDir);',
      'float ndl = dot(N, L);',
      'float night = 1.0 - smoothstep(-0.15, 0.06, ndl);'
    ].join('\n');
  }

  function buildShells(mesh) {
    var uniforms = {
      uSunDir: U.uSunDir,
      uNightTex: U.uNightTex,
      uGain: { value: 1.0 }
    };

    var darkMat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: VERT,
      fragmentShader: [
        'uniform vec3 uSunDir;',
        'varying vec2 vUv;',
        'varying vec3 vNw;',
        nightMaskGLSL(),
        'gl_FragColor = vec4(0.0, 0.0, 0.0, night * 0.36);'
      ].join('\n'),
      transparent: true,
      depthWrite: false
    });

    var glowMat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: VERT,
      fragmentShader: [
        'uniform vec3 uSunDir;',
        'uniform sampler2D uNightTex;',
        'uniform float uGain;',
        'varying vec2 vUv;',
        'varying vec3 vNw;',
        nightMaskGLSL(),
        'vec3 c = texture2D(uNightTex, vUv).rgb;',
        'vec3 c2 = max(c - vec3(0.03, 0.04, 0.08), 0.0);',
        'float lum = max(max(c2.r, c2.g), c2.b);',
        'vec3 col = vec3(1.0, 0.66, 0.38) * pow(lum, 1.2) * 9.0 * uGain;',
        'gl_FragColor = vec4(col, night * step(0.002, lum));'
      ].join('\n'),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    var dark = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), darkMat);
    dark.scale.setScalar(1.002);
    dark.renderOrder = 1;
    dark.name = '__earth_dark_shell';
    mesh.add(dark);

    var glow = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), glowMat);
    glow.scale.setScalar(1.003);
    glow.renderOrder = 2;
    glow.name = '__earth_glow_shell';
    mesh.add(glow);

    window.__earthInfo = { mode: 'shells', shells: 2 };
  }

  function findEarth(scene) {
    var found = null;
    scene.traverse(function (o) {
      if (found || !o.isMesh || !o.material || !o.material.map) return;
      var img = o.material.map.image;
      if (img && img.src && STEX.earth && img.src === STEX.earth) found = o;
    });
    return found;
  }

  var v = new THREE.Vector3();
  function tick() {
    if (!earth || !U) return;
    earth.getWorldPosition(v);
    if (v.lengthSq() > 1e-8) U.uSunDir.value.copy(v).normalize().negate();
  }

  function boot() {
    var s = (window.__scenes || [])[0] || window.__scene;
    if (!s) return setTimeout(boot, 300);
    earth = findEarth(s);
    if (!earth) return setTimeout(boot, 300);
    U = {
      uSunDir: { value: new THREE.Vector3(0, 0, 1) },
      uNightTex: { value: nightTexture() }
    };
    buildShells(earth);
    window.__earthMesh = earth;
    window.__earthU = U;
    window.__earthFrame = tick;
  }

  boot();
})();
