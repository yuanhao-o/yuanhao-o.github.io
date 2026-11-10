(function () {
  if (!window.THREE || window.__earthHooked) return;
  window.__earthHooked = true;
  var S = THREE.Scene;
  THREE.Scene = function () {
    var s = new S();
    (window.__scenes = window.__scenes || []).push(s);
    return s;
  };
  THREE.Scene.prototype = S.prototype;
  var R = THREE.WebGLRenderer;
  THREE.WebGLRenderer = function () {
    var r = new (Function.prototype.bind.apply(R, [null].concat([].slice.call(arguments))))();
    (window.__renderers = window.__renderers || []).push(r);
    var orig = r.render;
    r.render = function (scene, camera) {
      window.__scene = scene;
      window.__camera = camera;
      if (window.__earthFrame) window.__earthFrame(scene, camera);
      return orig.call(r, scene, camera);
    };
    return r;
  };
  THREE.WebGLRenderer.prototype = R.prototype;
})();
