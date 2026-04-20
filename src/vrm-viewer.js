import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

// 感情ごとのアイドルモーションへの加算オフセット
const EMOTION_POSE_OFFSETS = {
  happy: {
    chest:         { x:  0.12 },
    upperChest:    { x:  0.08 },
    head:          { x: -0.12, z:  0.08 },
    leftShoulder:  { z:  0.15 },
    rightShoulder: { z: -0.15 },
  },
  sad: {
    chest:         { x: -0.12 },
    upperChest:    { x: -0.08 },
    head:          { x:  0.18 },
    leftShoulder:  { z: -0.15 },
    rightShoulder: { z:  0.15 },
    leftUpperArm:  { z: -0.15 },
    rightUpperArm: { z:  0.15 },
  },
  angry: {
    chest:         { x:  0.15 },
    upperChest:    { x:  0.10 },
    head:          { x:  0.10 },
    leftShoulder:  { z:  0.12 },
    rightShoulder: { z: -0.12 },
    leftUpperArm:  { z:  0.12 },
    rightUpperArm: { z: -0.12 },
  },
  surprised: {
    chest:         { x: -0.08 },
    upperChest:    { x: -0.06 },
    head:          { x: -0.18 },
    leftShoulder:  { z:  0.28 },
    rightShoulder: { z: -0.28 },
  },
  relaxed: {
    spine:         { z:  0.05 },
    chest:         { x: -0.06 },
    upperChest:    { x: -0.04 },
    head:          { x: -0.06, y:  0.12 },
    leftShoulder:  { z: -0.12 },
    rightShoulder: { z:  0.08 },
  },
};

export class VRMViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.vrm = null;
    this.clock = new THREE.Clock();

    // まずレイアウトが確定してからサイズを取得
    this._w = canvas.clientWidth || 600;
    this._h = canvas.clientHeight || 600;

    this._initRenderer();
    this._initScene();
    this._initCamera();
    this._initControls();
    this._initLights();

    // アイドル VRMA パス（感情モーション終了後に戻る）
    this._idleVrmaUrl = null;

    // VRMA 補正角 (ラジアン)
    this._vrmaArmCorrectionRad = 0;
    this._vrmaShoulderCorrectionRad = 0;
    this._vrmaChestCorrectionRad = 0;

    // アイドルアニメーション用
    this._blinkTimer = 0;
    this._blinkInterval = 3 + Math.random() * 3;
    this._isBlinking = false;
    this._blinkProgress = 0;

    // 話し中フラグ
    this._isTalking = false;

    // 感情ポーズ（プロシージャル）
    this._emotionPose          = null;
    this._emotionBlend         = 0.0;
    this._emotionBlendTarget   = 0.0;
    this._emotionHoldRemaining = 0.0;

    // VRMAアニメーション
    this._mixer = null;
    this._vrmaAction = null;
    this._vrmaPlaying = false;

    // canvasサイズ変化時にrendererサイズを同期
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.canvas);

    this._animate();
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(this._w, this._h, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
  }

  _initScene() {
    this.scene = new THREE.Scene();
  }

  _initCamera() {
    this.camera = new THREE.PerspectiveCamera(28, this._w / this._h, 0.1, 20);
    this.camera.position.set(0, 1.35, 2.2);
    this.camera.lookAt(0, 1.35, 0);
  }

  _initControls() {
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(0, 1.35, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.update();
  }

  _initLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(1, 2, 1);
    this.scene.add(dir);
    const fill = new THREE.DirectionalLight(0xb0c8ff, 0.4);
    fill.position.set(-2, 1, -1);
    this.scene.add(fill);
  }

  /**
   * VRM ファイル (File オブジェクト or URL 文字列) を読み込む
   * @param {File|string} source
   * @param {function} onProgress
   */
  async loadVRM(source, onProgress) {
    // 既存モデルを削除
    this.stopVRMA();
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const url = source instanceof File ? URL.createObjectURL(source) : source;

    const gltf = await loader.loadAsync(url, (xhr) => {
      if (onProgress && xhr.total > 0) {
        onProgress(Math.round((xhr.loaded / xhr.total) * 100));
      }
    });

    const vrm = gltf.userData.vrm;
    VRMUtils.combineSkeletons(gltf.scene);

    // VRM 0.x は Z 軸が逆向きなので 180° 回転
    if (vrm.meta?.metaVersion === '0') {
      VRMUtils.rotateVRM0(vrm);
    }

    this.vrm = vrm;
    this.scene.add(vrm.scene);

    if (source instanceof File) URL.revokeObjectURL(url);

    // 上腕の初期Z角度を検出してアイドルモーションのベース値を決める
    // Tポーズ(腕水平)なら ~0、Aポーズ/腕下ろし済みなら ~1.2 に近い値が入っている
    this._armBaseZ = this._detectArmBaseZ(vrm);
    // ロード完了後にCSSレイアウトが確定してからフィット
    requestAnimationFrame(() => this._fitCameraToVRM(vrm));

    return vrm;
  }

  /**
   * モデルの上腕ボーン初期角度を読み取り、アイドルモーション用のベースZ値を返す
   * Tポーズ(腕水平)→ 1.2、Aポーズ/腕下ろし済み → 0 に近い値
   */
  _detectArmBaseZ(vrm) {
    const node = vrm.humanoid?.getNormalizedBoneNode('leftUpperArm');
    if (!node) return 0.0;
    // ロード直後の初期回転Z（ラジアン）をそのままベースに使う
    const initialZ = Math.abs(node.rotation.z);
    // 0.3 未満ならAポーズ/腕下ろし系、それ以上ならTポーズ系
    return initialZ < 0.3 ? 0.0 : 1.2;
  }

  /** モデルのバウンディングボックスに合わせてカメラと OrbitControls を自動調整 */
  _fitCameraToVRM(vrm) {
    this.resize();

    // ワールド行列を確定してからメッシュのみでbboxを計算
    // (ボーン・ヘルパーを含めると中心がズレるため)
    vrm.scene.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    vrm.scene.traverse((obj) => {
      if (obj.isMesh && obj.geometry) {
        box.expandByObject(obj);
      }
    });
    if (box.isEmpty()) box.setFromObject(vrm.scene); // フォールバック

    const size   = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // 縦・横それぞれ収まる距離を算出し、大きい方を採用
    const tanHalfFov = Math.tan((this.camera.fov * Math.PI / 180) / 2);
    const aspect     = this.camera.aspect;
    const distH = (size.y / 2) / tanHalfFov;
    const distW = (size.x / 2) / (aspect * tanHalfFov);
    const fitDist = Math.max(distH, distW) * 1.25;

    this.camera.position.set(center.x, center.y, center.z + fitDist);
    this.camera.near = fitDist * 0.01;
    this.camera.far  = fitDist * 10;
    this.camera.updateProjectionMatrix();

    this.controls.target.copy(center);
    this.controls.update();
  }


  // ---- VRMA アニメーション API ----

  /**
   * VRMAファイルを読み込んで再生する
   * @param {File|string} source
   * @param {{ loop?: boolean }} options
   */
  async loadVRMA(source, { loop = true, isIdle = false } = {}) {
    if (!this.vrm) throw new Error('先にVRMを読み込んでください');

    this.stopVRMA();

    // アイドルモーションとして登録
    if (isIdle && typeof source === 'string') {
      this._idleVrmaUrl = source;
    }

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    const url = source instanceof File ? URL.createObjectURL(source) : source;
    try {
      const gltf = await loader.loadAsync(url);
      const vrmAnimations = gltf.userData.vrmAnimations;
      if (!vrmAnimations || vrmAnimations.length === 0) {
        throw new Error('VRMAファイルにアニメーションが含まれていません');
      }

      const clip = createVRMAnimationClip(vrmAnimations[0], this.vrm);
      this._mixer = new THREE.AnimationMixer(this.vrm.scene);
      this._vrmaAction = this._mixer.clipAction(clip);

      if (!loop) {
        this._vrmaAction.setLoop(THREE.LoopOnce, 1);
        this._vrmaAction.clampWhenFinished = true;
        // 再生終了時にアイドルモーションへ戻る
        this._mixer.addEventListener('finished', () => {
          this.resetExpressions();
          if (this._idleVrmaUrl) {
            this.loadVRMA(this._idleVrmaUrl, { loop: true });
          } else {
            this.stopVRMA();
          }
        });
      }

      this._vrmaAction.play();
      this._vrmaPlaying = true;
    } finally {
      if (source instanceof File) URL.revokeObjectURL(url);
    }
  }

  /**
   * VRMA 補正角を設定する（度単位）
   */
  setVRMArmCorrection(degrees)      { this._vrmaArmCorrectionRad = (degrees * Math.PI) / 180; }
  setVRMAShoulderCorrection(degrees) { this._vrmaShoulderCorrectionRad = (degrees * Math.PI) / 180; }
  setVRMAChestCorrection(degrees)    { this._vrmaChestCorrectionRad = (degrees * Math.PI) / 180; }

  /**
   * ミキサーやアイドルモーションの後、vrm.update の直前にリアルタイムで補正角を掛ける
   * これによりスライダーを動かした瞬間に即座に反映される
   */
  _applyRealtimePoseCorrection() {
    if (!this.vrm?.humanoid) return;
    const armRad      = this._vrmaArmCorrectionRad;
    const shoulderRad = this._vrmaShoulderCorrectionRad;
    const chestRad    = this._vrmaChestCorrectionRad;
    if (!armRad && !shoulderRad && !chestRad) return;

    const h = this.vrm.humanoid;
    const nodes = {
      leftUpperArm:  h.getNormalizedBoneNode('leftUpperArm'),
      rightUpperArm: h.getNormalizedBoneNode('rightUpperArm'),
      leftShoulder:  h.getNormalizedBoneNode('leftShoulder'),
      rightShoulder: h.getNormalizedBoneNode('rightShoulder'),
      chest:         h.getNormalizedBoneNode('chest') || h.getNormalizedBoneNode('upperChest'),
    };

    // テンポラリオブジェクトを使い回す
    if (!this._qArmL) {
      this._qArmL = new THREE.Quaternion();
      this._qArmR = new THREE.Quaternion();
      this._qShL  = new THREE.Quaternion();
      this._qShR  = new THREE.Quaternion();
      this._qCh   = new THREE.Quaternion();
    }

    this._qArmL.setFromEuler(new THREE.Euler(0, 0,  armRad));
    this._qArmR.setFromEuler(new THREE.Euler(0, 0, -armRad));
    this._qShL.setFromEuler(new THREE.Euler(0,  shoulderRad, 0));
    this._qShR.setFromEuler(new THREE.Euler(0, -shoulderRad, 0));
    this._qCh.setFromEuler(new THREE.Euler(chestRad, 0, 0));

    // アニメーション適用後に、さらに各ボーンのローカル座標系で追加の回転を加える
    if (nodes.leftUpperArm)  nodes.leftUpperArm.quaternion.premultiply(this._qArmL);
    if (nodes.rightUpperArm) nodes.rightUpperArm.quaternion.premultiply(this._qArmR);
    if (nodes.leftShoulder)  nodes.leftShoulder.quaternion.premultiply(this._qShL);
    if (nodes.rightShoulder) nodes.rightShoulder.quaternion.premultiply(this._qShR);
    if (nodes.chest)         nodes.chest.quaternion.premultiply(this._qCh);
  }

  /** VRMAアニメーションを停止してアイドルモーションに戻す */
  stopVRMA() {
    if (this._mixer) {
      this._mixer.stopAllAction();
      this._mixer = null;
      this._vrmaAction = null;
    }
    this._vrmaPlaying = false;
  }

  // ---- 表情 API ----

  setExpression(name, value = 1.0) {
    this.vrm?.expressionManager?.setValue(name, Math.max(0, Math.min(1, value)));
  }

  resetExpressions() {
    if (!this.vrm?.expressionManager) return;
    ['happy', 'angry', 'sad', 'surprised', 'relaxed'].forEach((n) =>
      this.vrm.expressionManager.setValue(n, 0)
    );
  }

  /**
   * 感情名からアバターの表情とポーズを自動適用する
   * @param {'happy'|'sad'|'angry'|'surprised'|'relaxed'|'neutral'} emotion
   */
  applyEmotion(emotion) {
    const MAP = {
      happy:     { expr: 'happy',     intensity: 0.75 },
      sad:       { expr: 'sad',       intensity: 0.65 },
      angry:     { expr: 'angry',     intensity: 0.6  },
      surprised: { expr: 'surprised', intensity: 0.8  },
      relaxed:   { expr: 'relaxed',   intensity: 0.6  },
      neutral:   { expr: null,        intensity: 0    },
    };
    const entry = MAP[emotion] ?? MAP['neutral'];
    this.resetExpressions();
    if (entry.expr) this.setExpression(entry.expr, entry.intensity);
    this.setEmotionPose(emotion);
  }

  /**
   * プロシージャルな感情ポーズを設定する（neutral/null でフェードアウト）
   * @param {string|null} emotion
   */
  setEmotionPose(emotion) {
    if (!emotion || emotion === 'neutral') {
      this._emotionBlendTarget = 0.0;
      return;
    }
    this._emotionPose          = emotion;
    this._emotionBlendTarget   = 1.0;
    this._emotionHoldRemaining = 4.0;
  }

  _updateEmotionBlend(delta) {
    const BLEND_IN  = 3.0;
    const BLEND_OUT = 1.5;
    if (this._emotionBlendTarget > 0) {
      this._emotionHoldRemaining -= delta;
      if (this._emotionHoldRemaining <= 0) this._emotionBlendTarget = 0.0;
    }
    if (this._emotionBlend < this._emotionBlendTarget) {
      this._emotionBlend = Math.min(this._emotionBlendTarget, this._emotionBlend + BLEND_IN * delta);
    } else if (this._emotionBlend > this._emotionBlendTarget) {
      this._emotionBlend = Math.max(this._emotionBlendTarget, this._emotionBlend - BLEND_OUT * delta);
    }
  }

  _applyEmotionPoseOffset() {
    if (!this.vrm?.humanoid || this._emotionBlend <= 0 || !this._emotionPose) return;
    const offsets = EMOTION_POSE_OFFSETS[this._emotionPose];
    if (!offsets) return;
    const w = this._emotionBlend;
    if (Math.round(w * 10) % 10 === 0) console.debug('[EmotionPose]', this._emotionPose, 'blend=', w.toFixed(2));
    const h = this.vrm.humanoid;
    for (const [boneName, rot] of Object.entries(offsets)) {
      const node = h.getNormalizedBoneNode(boneName);
      if (!node) continue;
      if (rot.x !== undefined) node.rotation.x += rot.x * w;
      if (rot.y !== undefined) node.rotation.y += rot.y * w;
      if (rot.z !== undefined) node.rotation.z += rot.z * w;
    }
  }

  /** 口の形（リップシンク）
   *  phoneme: 'aa' | 'ih' | 'ou' | 'ee' | 'oh'
   */
  setLipSync(phoneme, value) {
    this.vrm?.expressionManager?.setValue(phoneme, Math.max(0, Math.min(1, value)));
  }

  resetLipSync() {
    ['aa', 'ih', 'ou', 'ee', 'oh'].forEach((p) => this.setLipSync(p, 0));
  }

  // ---- リサイズ ----

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this._w = w;
    this._h = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  // ---- アニメーションループ ----

  _updateBlinking(delta) {
    this._blinkTimer += delta;

    if (!this._isBlinking && this._blinkTimer >= this._blinkInterval) {
      this._isBlinking = true;
      this._blinkProgress = 0;
      this._blinkTimer = 0;
      this._blinkInterval = 3 + Math.random() * 4;
    }

    if (this._isBlinking) {
      this._blinkProgress += delta / 0.14;
      const v = Math.max(0, Math.sin(this._blinkProgress * Math.PI));
      this.vrm.expressionManager?.setValue('blink', v);
      if (this._blinkProgress >= 1) {
        this._isBlinking = false;
        this.vrm.expressionManager?.setValue('blink', 0);
      }
    }
  }

  // ---- 話し中モード ----

  /** LLM 返答開始時に呼ぶ */
  startTalking() { this._isTalking = true; }

  /** 返答終了時に呼ぶ */
  stopTalking() { this._isTalking = false; }

  // ---- アイドル・トーキングモーション ----

  _updateIdleMotion(t) {
    if (!this.vrm?.humanoid) return;
    const h = this.vrm.humanoid;

    const talking = this._isTalking;
    const breathAmp  = talking ? 0.022 : 0.012;
    const swayAmp    = talking ? 0.025 : 0.012;
    const headYAmp   = talking ? 0.06  : 0.04;
    const headXAmp   = talking ? 0.04  : 0.018;
    const shoulderAmp= talking ? 0.04  : 0.018;
    const armAmp     = talking ? 0.06  : 0.025;

    // --- 呼吸 (chest/upperChest) ---
    const breath = Math.sin(t * 1.6) * breathAmp;
    _rot(h, 'chest',      { x: breath });
    _rot(h, 'upperChest', { x: breath * 0.6 });

    // --- 体幹の揺れ ---
    _rot(h, 'spine', { z: Math.sin(t * 0.35) * swayAmp });
    _rot(h, 'hips',  { z: Math.sin(t * 0.28 + 0.5) * swayAmp * 0.5 });

    // --- 頭 ---
    const headNode = h.getNormalizedBoneNode('head');
    if (headNode) {
      headNode.rotation.y = Math.sin(t * 0.25) * headYAmp;
      headNode.rotation.x = Math.sin(t * 0.18) * headXAmp;
    }

    // --- 肩 ---
    _rot(h, 'leftShoulder',  { z:  Math.sin(t * 0.4) * shoulderAmp });
    _rot(h, 'rightShoulder', { z: -Math.sin(t * 0.4 + 0.3) * shoulderAmp });

    // --- 上腕 (z=0がAポーズ/腕下ろし系モデルの自然位置、Tポーズ系は1.2が適切) ---
    const armBaseZ = this._armBaseZ ?? 0.0;
    _rot(h, 'leftUpperArm',  { z:  armBaseZ + Math.sin(t * 0.5) * armAmp, x:  0.05 });
    _rot(h, 'rightUpperArm', { z: -armBaseZ - Math.sin(t * 0.5 + 0.4) * armAmp, x:  0.05 });

    // --- 前腕 ---
    _rot(h, 'leftLowerArm',  { z:  0.1 + Math.sin(t * 0.6) * 0.03 });
    _rot(h, 'rightLowerArm', { z: -0.1 - Math.sin(t * 0.6 + 0.2) * 0.03 });
  }

  // ---- アニメーションループ (更新) ----

  _animate() {
    requestAnimationFrame(() => this._animate());
    const delta = this.clock.getDelta();
    const elapsed = this.clock.getElapsedTime();

    if (this.vrm) {
      this._updateEmotionBlend(delta);
      this._updateBlinking(delta);
      if (!this._vrmaPlaying) this._updateIdleMotion(elapsed);
      if (this._mixer) this._mixer.update(delta);
      this._applyEmotionPoseOffset();
      
      // アニメーションミキサー適用後のリアルタイム姿勢補正
      this._applyRealtimePoseCorrection();
      
      this.vrm.update(delta);
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

// ---- ユーティリティ ----

/** ボーンが存在する場合のみ rotation を部分的に上書きするヘルパー */
function _rot(humanoid, boneName, rotation) {
  const node = humanoid.getNormalizedBoneNode(boneName);
  if (!node) return;
  if (rotation.x !== undefined) node.rotation.x = rotation.x;
  if (rotation.y !== undefined) node.rotation.y = rotation.y;
  if (rotation.z !== undefined) node.rotation.z = rotation.z;
}
