/* Browser scene for Football // Spatial Replay. Requires THREE and FB3DCore globals. */
(async function () {
  'use strict';
  const C = window.FB3DCore;
  const T = window.THREE;
  const $ = (id) => document.getElementById(id);
  const app = $('app'), loader = $('loader'), fatal = $('fatal'), fatalMessage = $('fatal-message');

  function die(message) {
    loader.classList.add('hidden');
    fatalMessage.textContent = message;
    fatal.classList.remove('hidden');
  }

  const probe = document.createElement('canvas');
  if (!probe.getContext('webgl2') && !probe.getContext('webgl')) {
    die('WebGL is unavailable in this browser. Try a current version of Chrome, Edge, Firefox, or Safari.');
    return;
  }

  let roster = {};
  try { roster = JSON.parse($('football-roster').textContent || '{}'); }
  catch (_) { roster = {}; }

  function metadataFor(entity) {
    const raw = roster[`${entity.teamName}:${entity.jersey}`] || {};
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const image = typeof raw.image === 'string' ? raw.image.trim() : '';
    return {
      name,
      image,
      credit: typeof raw.credit === 'string' ? raw.credit.trim() : '',
      license: typeof raw.license === 'string' ? raw.license.trim() : '',
      source: typeof raw.source === 'string' ? raw.source.trim() : '',
      displayName: name || (entity.team === 2 ? 'Match official' : `${entity.teamName} player`),
    };
  }

  let data;
  try {
    const b64 = $('football-data').textContent.trim();
    data = await C.decodeBlob(b64);
  } catch (error) {
    console.error('FB3D decode error:', error && error.message ? error.message : 'unknown error');
    die('The embedded tracking data could not be decoded. This browser may not support raw Deflate streams.');
    return;
  }

  const playerMetadata = data.entities.map(metadataFor);

  // ------------------------------------------------------------------ renderer and scene
  const renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  app.appendChild(renderer.domElement);

  const scene = new T.Scene();
  scene.background = new T.Color(0x9fc6d5);
  scene.fog = new T.FogExp2(0xb8ced3, 0.0024);
  const camera = new T.PerspectiveCamera(46, innerWidth / innerHeight, 0.04, 420);
  scene.add(new T.HemisphereLight(0xdaf5ff, 0x3d6638, 1.7));
  const sun = new T.DirectionalLight(0xfff1cf, 2.7);
  sun.position.set(-42, 68, 31);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-85;sun.shadow.camera.right=85;sun.shadow.camera.top=70;sun.shadow.camera.bottom=-70;sun.shadow.camera.near=1;sun.shadow.camera.far=180;
  scene.add(sun);
  const rim = new T.DirectionalLight(0xc8eaff, .65);
  rim.position.set(40, 18, -45);
  scene.add(rim);

  const teamColors = C.TEAM_COLORS.map((x) => new T.Color(x));
  const neutralColor = new T.Color(C.COLORS.neutral);
  const up = new T.Vector3(0, 1, 0);
  const tmpObject = new T.Object3D();
  const tmpV = new T.Vector3(), tmpV2 = new T.Vector3(), tmpColor = new T.Color();

  // ------------------------------------------------------------------ pitch and stadium
  const pitch = new T.Group();
  scene.add(pitch);
  const pitchBase=new T.Mesh(new T.PlaneGeometry(111,74),new T.MeshStandardMaterial({color:0x315f3d,roughness:.98}));
  pitchBase.rotation.x=-Math.PI/2;pitchBase.position.y=-.035;pitchBase.receiveShadow=true;pitch.add(pitchBase);

  // One high-resolution procedural grass texture: light mowing stripes plus subtle grain.
  const grassCanvas=document.createElement('canvas');grassCanvas.width=1260;grassCanvas.height=816;
  const grassCtx=grassCanvas.getContext('2d'),grassStripeCount=14;
  for(let i=0;i<grassStripeCount;i++){grassCtx.fillStyle=i%2?'#43a957':'#51b861';grassCtx.fillRect(i*grassCanvas.width/grassStripeCount,0,grassCanvas.width/grassStripeCount+1,grassCanvas.height);}
  let grassSeed=99173;const grassRandom=()=>((grassSeed=(Math.imul(grassSeed,1664525)+1013904223)>>>0)/4294967296);
  for(let i=0;i<18000;i++){const shade=grassRandom()>.5?'rgba(255,255,220,.055)':'rgba(0,45,12,.055)';grassCtx.fillStyle=shade;grassCtx.fillRect(grassRandom()*grassCanvas.width,grassRandom()*grassCanvas.height,1+grassRandom()*2,1+grassRandom()*2);}
  const grassTexture=new T.CanvasTexture(grassCanvas);grassTexture.colorSpace=T.SRGBColorSpace;grassTexture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  const field=new T.Mesh(new T.PlaneGeometry(105,68),new T.MeshStandardMaterial({map:grassTexture,color:0xffffff,roughness:.94,metalness:0}));
  field.rotation.x=-Math.PI/2;field.position.y=0;field.receiveShadow=true;pitch.add(field);

  const markings = new T.Group();
  scene.add(markings);
  const markMaterial = new T.LineBasicMaterial({ color: 0xdfffea, transparent: true, opacity: 0.9 });
  const markGlowMaterial = new T.LineBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.17, blending: T.AdditiveBlending });

  function line(points, material = markMaterial, target = markings) {
    const geometry = new T.BufferGeometry().setFromPoints(points.map((p) => new T.Vector3(p[0], 0.035, p[1])));
    const obj = new T.Line(geometry, material);
    target.add(obj);
    return obj;
  }
  function rect(x1, z1, x2, z2, material) {
    line([[x1,z1],[x2,z1],[x2,z2],[x1,z2],[x1,z1]], material);
  }
  function arc(cx, cz, radius, start = 0, end = Math.PI * 2, material) {
    const points = [];
    for (let i = 0; i <= 72; i++) {
      const a = start + (end - start) * i / 72;
      points.push([cx + Math.cos(a) * radius, cz + Math.sin(a) * radius]);
    }
    line(points, material);
  }
  rect(-52.5, -34, 52.5, 34);
  line([[0,-34],[0,34]]); arc(0, 0, 9.15);
  rect(-52.5, -20.16, -36, 20.16); rect(36, -20.16, 52.5, 20.16);
  rect(-52.5, -9.16, -47, 9.16); rect(47, -9.16, 52.5, 9.16);
  arc(-41.5, 0, 9.15, -0.93, 0.93); arc(41.5, 0, 9.15, Math.PI - 0.93, Math.PI + 0.93);
  arc(0, 0, 0.22); arc(-41.5, 0, 0.18); arc(41.5, 0, 0.18);
  // A faint cyan outline gives the pitch the requested neon edge without obscuring markings.
  rect(-52.72, -34.22, 52.72, 34.22, markGlowMaterial);

  function makeGoal(x, sign) {
    const g = new T.Group();
    const mat = new T.LineBasicMaterial({ color: 0xbceeff, transparent: true, opacity: 0.72 });
    const w = 7.32 / 2, h = 2.44, d = 2.2;
    const pts = [
      [x,0,-w],[x,h,-w],[x,h,w],[x,0,w],
      [x,h,-w],[x + sign*d,h,-w],[x + sign*d,0,-w],[x,0,-w],
      [x,h,w],[x + sign*d,h,w],[x + sign*d,0,w],[x,0,w],
      [x + sign*d,0,-w],[x + sign*d,h,-w],[x + sign*d,h,w],[x + sign*d,0,w],[x + sign*d,0,-w]
    ].map(([a,b,c]) => new T.Vector3(a,b,c));
    const geo = new T.BufferGeometry().setFromPoints(pts);
    g.add(new T.Line(geo, mat));
    scene.add(g);
  }
  makeGoal(-52.5, -1); makeGoal(52.5, 1);

  // ------------------------------------------------------------------ stadium and audience
  const stadiumGroup=new T.Group();scene.add(stadiumGroup);
  const crowdRoot=new T.Group();stadiumGroup.add(crowdRoot);
  const stadiumTmp=new T.Object3D();

  // Holographic apron outside the field.
  const grid=new T.GridHelper(158,32,0x708b86,0x63766f);grid.position.y=-.06;
  grid.material.transparent=true;grid.material.opacity=.10;stadiumGroup.add(grid);
  const apron=new T.Mesh(new T.RingGeometry(61,79,96),new T.MeshBasicMaterial({color:0x445d50,side:T.DoubleSide,transparent:true,opacity:.96}));
  apron.rotation.x=-Math.PI/2;apron.position.y=-.08;stadiumGroup.add(apron);

  // Four steep, stepped grandstands. Instancing keeps the whole structure to one draw call.
  const ROWS=18;
  const stepMesh=new T.InstancedMesh(new T.BoxGeometry(1,1,1),new T.MeshStandardMaterial({color:0x59676b,roughness:.88,metalness:.08}),ROWS*4);
  let stepIndex=0;
  for(const sign of [-1,1])for(let row=0;row<ROWS;row++){
    stadiumTmp.position.set(0,.08+row*.39,sign*(36.1+row*.68));stadiumTmp.scale.set(118,.22,.76);stadiumTmp.rotation.set(0,0,0);stadiumTmp.updateMatrix();stepMesh.setMatrixAt(stepIndex++,stadiumTmp.matrix);
  }
  for(const sign of [-1,1])for(let row=0;row<ROWS;row++){
    stadiumTmp.position.set(sign*(54.6+row*.68),.08+row*.39,0);stadiumTmp.scale.set(.76,.22,72);stadiumTmp.rotation.set(0,0,0);stadiumTmp.updateMatrix();stepMesh.setMatrixAt(stepIndex++,stadiumTmp.matrix);
  }
  stepMesh.count=stepIndex;stepMesh.castShadow=true;stepMesh.receiveShadow=true;stadiumGroup.add(stepMesh);

  const concrete=new T.MeshStandardMaterial({color:0x4c5b60,roughness:.82,metalness:.16});
  function stadiumBox(size,pos,mat=concrete){const m=new T.Mesh(new T.BoxGeometry(...size),mat);m.position.set(...pos);m.castShadow=true;m.receiveShadow=true;stadiumGroup.add(m);return m;}
  stadiumBox([124,10,.7],[0,4.6,-49]);stadiumBox([124,10,.7],[0,4.6,49]);
  stadiumBox([.7,10,77],[-67,4.6,0]);stadiumBox([.7,10,77],[67,4.6,0]);
  const roofMat=new T.MeshStandardMaterial({color:0x6e8188,metalness:.62,roughness:.3,transparent:true,opacity:.94});
  stadiumBox([126,.45,10],[0,10.8,-50],roofMat);stadiumBox([126,.45,10],[0,10.8,50],roofMat);
  stadiumBox([10,.45,82],[-69,10.8,0],roofMat);stadiumBox([10,.45,82],[69,10.8,0],roofMat);
  // Roof fascia glows softly and frames the bowl.
  const fasciaMat=new T.MeshBasicMaterial({color:0x31dfff,transparent:true,opacity:.18,blending:T.AdditiveBlending});
  stadiumBox([126,.12,.12],[0,10.55,-45],fasciaMat);stadiumBox([126,.12,.12],[0,10.55,45],fasciaMat);
  stadiumBox([.12,.12,82],[-64,10.55,0],fasciaMat);stadiumBox([.12,.12,82],[64,10.55,0],fasciaMat);

  // Deterministic, individually colored audience: about 3,600 people in two instanced meshes.
  let crowdSeed=0x19fc1900;
  const crowdRandom=()=>((crowdSeed=(Math.imul(crowdSeed,1664525)+1013904223)>>>0)/4294967296);
  const audience=[];
  for(const sign of [-1,1])for(let row=0;row<ROWS;row++)for(let seat=0;seat<74;seat++){
    if(crowdRandom()<.08)continue;
    audience.push({x:-55.5+(seat+.5)*111/74,y:.46+row*.39,z:sign*(36.15+row*.68),phase:crowdRandom()*Math.PI*2});
  }
  for(const sign of [-1,1])for(let row=0;row<ROWS;row++)for(let seat=0;seat<41;seat++){
    if(crowdRandom()<.08)continue;
    audience.push({x:sign*(54.65+row*.68),y:.46+row*.39,z:-32+(seat+.5)*64/41,phase:crowdRandom()*Math.PI*2});
  }
  const crowdBody=new T.InstancedMesh(new T.CylinderGeometry(.12,.18,.45,5),new T.MeshStandardMaterial({roughness:.82,metalness:.04}),audience.length);
  const crowdHead=new T.InstancedMesh(new T.SphereGeometry(.105,5,4),new T.MeshStandardMaterial({roughness:.93}),audience.length);
  crowdBody.instanceColor=new T.InstancedBufferAttribute(new Float32Array(audience.length*3),3);
  crowdHead.instanceColor=new T.InstancedBufferAttribute(new Float32Array(audience.length*3),3);
  const crowdPalette=[0xd7193f,0xf2f2ef,0x8d102b,0x182b56,0x11161a,0x59727d,0xc7a24a];
  const skinPalette=[0xf0c5a2,0xd99b73,0xb97853,0x8b583d,0x5e3a2d];
  audience.forEach((person,i)=>{
    const bob=(i%17===0?.08:0);
    stadiumTmp.position.set(person.x,person.y+bob,person.z);stadiumTmp.scale.set(1,1,1);stadiumTmp.rotation.set(0,0,0);stadiumTmp.updateMatrix();crowdBody.setMatrixAt(i,stadiumTmp.matrix);
    stadiumTmp.position.y=person.y+.32+bob;stadiumTmp.updateMatrix();crowdHead.setMatrixAt(i,stadiumTmp.matrix);
    const bias=crowdRandom(),shirt=bias<.48?crowdPalette[Math.floor(crowdRandom()*3)]:crowdPalette[Math.floor(crowdRandom()*crowdPalette.length)];
    crowdBody.setColorAt(i,new T.Color(shirt));crowdHead.setColorAt(i,new T.Color(skinPalette[Math.floor(crowdRandom()*skinPalette.length)]));
  });
  crowdBody.frustumCulled=false;crowdHead.frustumCulled=false;crowdRoot.add(crowdBody,crowdHead);

  // Animated home flags distributed through the stands.
  const flagCanvas=document.createElement('canvas');flagCanvas.width=192;flagCanvas.height=112;
  const flagCtx=flagCanvas.getContext('2d');flagCtx.fillStyle='#d7193f';flagCtx.fillRect(0,0,192,112);flagCtx.fillStyle='#f4f7ff';flagCtx.fillRect(0,42,192,28);flagCtx.fillStyle='#9b0d28';flagCtx.font='900 24px system-ui';flagCtx.textAlign='center';flagCtx.fillText('MÜNCHEN',96,67);
  const flagTexture=new T.CanvasTexture(flagCanvas);flagTexture.colorSpace=T.SRGBColorSpace;
  const flagMaterial=new T.MeshBasicMaterial({map:flagTexture,side:T.DoubleSide,transparent:true});
  const crowdFlags=[];
  for(let i=0;i<20;i++){
    const g=new T.Group(),pole=new T.Mesh(new T.CylinderGeometry(.018,.018,1.3,5),new T.MeshBasicMaterial({color:0xd7e4e7}));pole.position.y=.65;g.add(pole);
    const f=new T.Mesh(new T.PlaneGeometry(.9,.52,8,2),flagMaterial);f.position.set(.45,1.02,0);g.add(f);
    const side=i%4,row=5+(i*7)%11,along=((i*37)%100)/100;
    if(side<2)g.position.set(-48+along*96,.45+row*.39,(side?1:-1)*(36.2+row*.68));
    else g.position.set((side===2?-1:1)*(54.7+row*.68),.45+row*.39,-27+along*54);
    g.userData.phase=i*.73;crowdFlags.push(g);crowdRoot.add(g);
  }

  // Pitch-side LED ribbon, generated locally and requiring no image assets.
  const ledCanvas=document.createElement('canvas');ledCanvas.width=1024;ledCanvas.height=64;
  const ledCtx=ledCanvas.getContext('2d'),ledGrad=ledCtx.createLinearGradient(0,0,1024,0);ledGrad.addColorStop(0,'#00e5ff');ledGrad.addColorStop(.5,'#ff2d95');ledGrad.addColorStop(1,'#00e5ff');ledCtx.fillStyle='#031014';ledCtx.fillRect(0,0,1024,64);ledCtx.fillStyle=ledGrad;ledCtx.font='800 26px system-ui';ledCtx.textAlign='center';ledCtx.fillText('SPATIAL REPLAY  •  MÜNCHEN  •  LIVE MOTION DATA  •  SPATIAL REPLAY',512,42);
  const ledTexture=new T.CanvasTexture(ledCanvas);ledTexture.colorSpace=T.SRGBColorSpace;
  const ledMat=new T.MeshBasicMaterial({map:ledTexture,side:T.DoubleSide,toneMapped:false});
  const ledNorth=new T.Mesh(new T.PlaneGeometry(104,1.0),ledMat);ledNorth.position.set(0,.55,-35.2);stadiumGroup.add(ledNorth);
  const ledSouth=ledNorth.clone();ledSouth.position.z=35.2;stadiumGroup.add(ledSouth);
  const ledWest=new T.Mesh(new T.PlaneGeometry(68,1.0),ledMat);ledWest.rotation.y=Math.PI/2;ledWest.position.set(-53.7,.55,0);stadiumGroup.add(ledWest);
  const ledEast=ledWest.clone();ledEast.position.x=53.7;stadiumGroup.add(ledEast);

  // Large end scoreboard.
  const boardCanvas=document.createElement('canvas');boardCanvas.width=640;boardCanvas.height=240;const boardCtx=boardCanvas.getContext('2d');
  boardCtx.fillStyle='#02080b';boardCtx.fillRect(0,0,640,240);boardCtx.strokeStyle='#00e5ff';boardCtx.lineWidth=9;boardCtx.strokeRect(8,8,624,224);boardCtx.fillStyle='#8aaeb7';boardCtx.font='700 24px system-ui';boardCtx.textAlign='center';boardCtx.fillText('SPATIAL REPLAY',320,52);boardCtx.fillStyle='#fff';boardCtx.font='900 64px system-ui';boardCtx.fillText('HOME   —   AWAY',320,137);boardCtx.fillStyle='#ff2d95';boardCtx.font='700 23px system-ui';boardCtx.fillText('3D MOTION TELEMETRY',320,194);
  const boardTexture=new T.CanvasTexture(boardCanvas);boardTexture.colorSpace=T.SRGBColorSpace;const board=new T.Mesh(new T.PlaneGeometry(12,4.5),new T.MeshBasicMaterial({map:boardTexture,toneMapped:false}));board.rotation.y=Math.PI/2;board.position.set(-66.5,13,0);stadiumGroup.add(board);

  // Four high floodlight towers, now part of the stadium layer.
  for(const [x,z] of [[-61,-42],[-61,42],[61,-42],[61,42]]){
    const tower=new T.Group();const pole=new T.Mesh(new T.CylinderGeometry(.1,.17,19,8),new T.MeshStandardMaterial({color:0x34515a,metalness:.72,roughness:.23}));pole.position.y=9.5;tower.add(pole);
    const lamp=new T.Mesh(new T.BoxGeometry(3.4,.6,.7),new T.MeshBasicMaterial({color:0xd8fbff,toneMapped:false}));lamp.position.y=19;tower.add(lamp);tower.position.set(x,0,z);stadiumGroup.add(tower);
  }

  // ------------------------------------------------------------------ people (batched/instanced)
  const maxJoints = data.K * C.NJ;
  const maxBones = data.K * C.BONES.length;
  const jointMaterial = new T.MeshStandardMaterial({ roughness: 0.18, metalness: 0.25, emissiveIntensity: 1.25 });
  const jointMesh = new T.InstancedMesh(new T.SphereGeometry(0.085, 7, 5), jointMaterial, maxJoints);
  jointMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
  jointMesh.instanceColor = new T.InstancedBufferAttribute(new Float32Array(maxJoints * 3), 3);
  jointMesh.frustumCulled = false;
  scene.add(jointMesh);

  // Thin luminous bones plus a distinct head make the tracked poses read as stick figures.
  const headMaterial = new T.MeshStandardMaterial({ roughness: 0.16, metalness: 0.22 });
  const headMesh = new T.InstancedMesh(new T.SphereGeometry(0.16, 10, 7), headMaterial, data.K);
  headMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
  headMesh.instanceColor = new T.InstancedBufferAttribute(new Float32Array(data.K * 3), 3);
  headMesh.frustumCulled = false;
  scene.add(headMesh);

  const boneMaterial = new T.MeshStandardMaterial({ roughness: 0.3, metalness: 0.18, emissiveIntensity: 0.75 });
  const boneMesh = new T.InstancedMesh(new T.CylinderGeometry(0.035, 0.045, 1, 5), boneMaterial, maxBones);
  boneMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
  boneMesh.instanceColor = new T.InstancedBufferAttribute(new Float32Array(maxBones * 3), 3);
  boneMesh.frustumCulled = false;
  scene.add(boneMesh);

  const auraMesh = new T.InstancedMesh(
    new T.RingGeometry(0.28, 0.38, 20),
    new T.MeshBasicMaterial({ transparent: true, opacity: 0.55, side: T.DoubleSide, blending: T.AdditiveBlending, vertexColors: true }),
    data.K
  );
  auraMesh.instanceColor = new T.InstancedBufferAttribute(new Float32Array(data.K * 3), 3);
  auraMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
  auraMesh.frustumCulled = false;
  scene.add(auraMesh);

  const jointsScratch = Array.from({length: data.K}, () => new Float32Array(C.NCH));
  const masksScratch = Array.from({length: data.K}, () => new Uint8Array(C.NJ));
  const jointOwners = new Int16Array(maxJoints).fill(-1);
  const visiblePerson = new Uint8Array(data.K);

  function makeLabel(entity, index) {
    const meta = playerMetadata[index];
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 88;
    const ctx = canvas.getContext('2d');
    const col = C.TEAM_COLORS[entity.team] || C.COLORS.neutral;
    ctx.clearRect(0,0,320,88);
    ctx.shadowColor = col; ctx.shadowBlur = 18;
    ctx.fillStyle = 'rgba(2,8,11,.86)'; ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(4,4,312,80,14); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 7; ctx.textBaseline = 'middle';
    ctx.fillStyle = col; ctx.font = '900 34px system-ui'; ctx.textAlign = 'left';
    ctx.fillText(`#${entity.jersey}`, 18, 44);
    ctx.fillStyle = '#efffff'; ctx.font = '700 22px system-ui';
    const title = meta.displayName.toUpperCase();
    ctx.fillText(title.length > 19 ? title.slice(0,18) + '…' : title, 92, 36);
    ctx.fillStyle = '#7ea7af'; ctx.font = '600 12px system-ui';
    ctx.fillText(entity.teamName.toUpperCase(), 92, 59);
    const tex = new T.CanvasTexture(canvas); tex.colorSpace = T.SRGBColorSpace;
    const sprite = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.set(4.5, 1.24, 1); sprite.visible = false; scene.add(sprite); return sprite;
  }
  const labels = data.entities.map(makeLabel);

  function makeCartoonSprite(entity, index) {
    const meta = playerMetadata[index], W = 256, H = 320;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const named = {
      'Harry Kane':      {skin:'#e8b28d',hair:'#8b5a3b',beard:true,hairStyle:'crop'},
      'Serge Gnabry':    {skin:'#8a563d',hair:'#171311',beard:true,hairStyle:'curl'},
      'Leon Goretzka':   {skin:'#e4ae89',hair:'#4b3025',beard:false,hairStyle:'sweep'},
      'Eric Dier':       {skin:'#e2aa86',hair:'#3a281f',beard:true,hairStyle:'crop'},
      'Alphonso Davies': {skin:'#72442f',hair:'#15110f',beard:false,hairStyle:'curl'},
      'Sacha Boey':      {skin:'#81513b',hair:'#171210',beard:true,hairStyle:'crop'},
      'Thomas Müller':   {skin:'#e7b18d',hair:'#7b5238',beard:false,hairStyle:'sweep'},
    };
    const skins=['#e7b18b','#c9825f','#8d573e','#693e2e','#d99a75'];
    const hairs=['#241813','#5a3827','#1a1513','#93663f','#d0a467'];
    const look=named[meta.name]||{skin:skins[(entity.jersey+entity.team)%skins.length],hair:hairs[(entity.jersey*3+entity.team)%hairs.length],beard:entity.jersey%4===0,hairStyle:['crop','curl','sweep'][entity.jersey%3]};
    const kit=entity.team===0?{shirt:'#d7193f',accent:'#f4f7ff',shorts:'#a7102b',sock:'#d7193f'}:entity.team===1?{shirt:'#174a9c',accent:'#66d7ff',shorts:'#10244b',sock:'#174a9c'}:{shirt:'#f3c800',accent:'#171717',shorts:'#171717',sock:'#f3c800'};
    const outline='#171016';
    const path=(points,fill,stroke=outline,width=7)=>{ctx.beginPath();ctx.moveTo(...points[0]);for(let i=1;i<points.length;i++)ctx.lineTo(...points[i]);ctx.closePath();ctx.fillStyle=fill;ctx.fill();ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.lineJoin='round';ctx.stroke();};
    ctx.clearRect(0,0,W,H);ctx.lineCap='round';ctx.lineJoin='round';
    // Soft cartoon shadow.
    ctx.save();ctx.globalAlpha=.25;ctx.fillStyle='#000';ctx.beginPath();ctx.ellipse(128,306,72,11,0,0,Math.PI*2);ctx.fill();ctx.restore();
    // Bent legs and oversized boots.
    ctx.strokeStyle=look.skin;ctx.lineWidth=23;ctx.beginPath();ctx.moveTo(102,235);ctx.lineTo(91,276);ctx.lineTo(74,297);ctx.moveTo(154,235);ctx.lineTo(166,276);ctx.lineTo(185,297);ctx.stroke();
    ctx.strokeStyle=kit.sock;ctx.lineWidth=25;ctx.beginPath();ctx.moveTo(91,269);ctx.lineTo(76,295);ctx.moveTo(165,269);ctx.lineTo(182,295);ctx.stroke();
    ctx.strokeStyle=outline;ctx.lineWidth=8;ctx.beginPath();ctx.moveTo(55,301);ctx.lineTo(84,301);ctx.moveTo(174,301);ctx.lineTo(204,301);ctx.stroke();
    // Shorts, body and energetic arms.
    path([[80,216],[176,216],[169,254],[133,246],[128,225],[123,246],[86,254]],kit.shorts);
    ctx.strokeStyle=look.skin;ctx.lineWidth=25;ctx.beginPath();ctx.moveTo(79,158);ctx.lineTo(46,193);ctx.lineTo(67,213);ctx.moveTo(177,158);ctx.lineTo(210,190);ctx.lineTo(190,211);ctx.stroke();
    ctx.fillStyle=look.skin;ctx.strokeStyle=outline;ctx.lineWidth=6;for(const [x,y] of [[65,212],[191,210]]){ctx.beginPath();ctx.arc(x,y,15,0,Math.PI*2);ctx.fill();ctx.stroke();}
    path([[76,142],[104,126],[152,126],[180,142],[174,225],[82,225]],kit.shirt);
    // Kit accents and jersey number.
    ctx.strokeStyle=kit.accent;ctx.lineWidth=7;ctx.beginPath();ctx.moveTo(86,151);ctx.lineTo(80,204);ctx.moveTo(170,151);ctx.lineTo(176,204);ctx.stroke();
    ctx.fillStyle=kit.accent;ctx.font='900 46px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(entity.jersey),128,181);
    // Neck and deliberately oversized caricature head.
    ctx.fillStyle=look.skin;ctx.strokeStyle=outline;ctx.lineWidth=7;ctx.beginPath();ctx.roundRect(111,112,34,35,8);ctx.fill();ctx.stroke();
    ctx.beginPath();ctx.ellipse(128,75,59,69,-.03,0,Math.PI*2);ctx.fillStyle=look.skin;ctx.fill();ctx.strokeStyle=outline;ctx.lineWidth=8;ctx.stroke();
    // Ears.
    for(const x of [70,186]){ctx.beginPath();ctx.ellipse(x,80,12,17,0,0,Math.PI*2);ctx.fillStyle=look.skin;ctx.fill();ctx.strokeStyle=outline;ctx.lineWidth=6;ctx.stroke();}
    // Hair silhouette.
    ctx.fillStyle=look.hair;ctx.strokeStyle=outline;ctx.lineWidth=7;ctx.beginPath();
    if(look.hairStyle==='curl'){
      ctx.moveTo(75,63);for(let x=78;x<=181;x+=13){ctx.arc(x,34+(x%3)*3,16,Math.PI,0);}ctx.lineTo(184,68);ctx.quadraticCurveTo(128,44,75,63);
    }else if(look.hairStyle==='sweep'){
      ctx.moveTo(74,62);ctx.quadraticCurveTo(86,3,178,18);ctx.quadraticCurveTo(198,32,181,68);ctx.quadraticCurveTo(130,42,74,62);
    }else{
      ctx.moveTo(75,62);ctx.quadraticCurveTo(85,14,126,13);ctx.quadraticCurveTo(181,10,184,65);ctx.quadraticCurveTo(130,40,75,62);
    }
    ctx.closePath();ctx.fill();ctx.stroke();
    // Beard for named players such as Kane, kept graphic rather than photographic.
    if(look.beard){ctx.fillStyle=look.hair;ctx.beginPath();ctx.moveTo(79,88);ctx.quadraticCurveTo(90,143,128,145);ctx.quadraticCurveTo(169,142,179,88);ctx.quadraticCurveTo(157,126,128,128);ctx.quadraticCurveTo(98,126,79,88);ctx.fill();}
    // Eyebrows, eyes, nose, smile.
    ctx.strokeStyle=outline;ctx.lineWidth=7;ctx.beginPath();ctx.moveTo(87,68);ctx.quadraticCurveTo(101,60,114,68);ctx.moveTo(142,68);ctx.quadraticCurveTo(156,60,170,68);ctx.stroke();
    ctx.fillStyle='#fff';for(const x of [102,154]){ctx.beginPath();ctx.ellipse(x,79,13,9,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle=outline;ctx.lineWidth=4;ctx.stroke();ctx.fillStyle='#222';ctx.beginPath();ctx.arc(x,79,4.5,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';}
    ctx.strokeStyle=outline;ctx.lineWidth=5;ctx.beginPath();ctx.moveTo(128,79);ctx.lineTo(122,98);ctx.lineTo(133,99);ctx.stroke();
    ctx.beginPath();ctx.moveTo(107,112);ctx.quadraticCurveTo(128,124,151,111);ctx.stroke();
    // Small name plate integrated into the character.
    const shortName=meta.name?meta.name.split(' ').slice(-1)[0].toUpperCase():(entity.teamName.toUpperCase());
    ctx.fillStyle='rgba(3,8,12,.88)';ctx.strokeStyle=kit.accent;ctx.lineWidth=3;ctx.beginPath();ctx.roundRect(47,270,162,32,9);ctx.fill();ctx.stroke();ctx.fillStyle='#fff';ctx.font='800 16px system-ui';ctx.fillText(shortName,128,287);
    const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;
    // For mapped Bayern players, replace only the oversized cartoon face with a
    // locally embedded Wikimedia Commons portrait. The kit/body remains drawn.
    if(meta.image){
      const image=new Image();
      image.onload=()=>{
        const x=74,y=8,w=108,h=130,scale=Math.max(w/image.width,h/image.height);
        const dw=image.width*scale,dh=image.height*scale;
        ctx.save();ctx.beginPath();ctx.ellipse(128,75,54,64,-.03,0,Math.PI*2);ctx.clip();
        ctx.drawImage(image,128-dw/2,75-dh*.42,dw,dh);ctx.restore();
        ctx.beginPath();ctx.ellipse(128,75,57,67,-.03,0,Math.PI*2);ctx.strokeStyle=outline;ctx.lineWidth=8;ctx.stroke();
        texture.needsUpdate=true;
      };
      image.src=meta.image;
    }
    const sprite=new T.Sprite(new T.SpriteMaterial({map:texture,transparent:true,depthTest:true,depthWrite:false,alphaTest:.02}));
    sprite.scale.set(1.55,1.95,1);sprite.visible=false;sprite.userData={entityIndex:index,canvas};scene.add(sprite);return sprite;
  }
  const avatarSprites = data.entities.map(makeCartoonSprite);

  const creditsBox=$('photo-credits');
  playerMetadata.forEach((meta)=>{
    if(!meta.image||!meta.credit)return;
    const line=document.createElement('div');line.style.marginBottom='6px';
    line.append(document.createTextNode(`${meta.displayName}: ${meta.credit} · ${meta.license} · `));
    if(meta.source){const link=document.createElement('a');link.href=meta.source;link.target='_blank';link.rel='noopener';link.textContent='source';link.style.color='#83dff1';line.append(link);}
    creditsBox.append(line);
  });

  function showPlayerCard(index) {
    const entity=data.entities[index],meta=playerMetadata[index],card=$('player-card'),photo=$('player-photo'),fallback=$('portrait-fallback');
    card.style.setProperty('--player-color',C.TEAM_COLORS[entity.team]||C.COLORS.neutral);
    $('player-team').textContent=entity.team===0&&meta.name?'FC Bayern · Home mapping*':entity.teamName;
    $('player-name').textContent=meta.displayName;$('player-jersey').textContent=`Jersey #${entity.jersey}`;
    $('player-credit').textContent=meta.credit?`Face: ${meta.credit} · ${meta.license}`:'Original generated cartoon face';
    photo.src=avatarSprites[index].userData.canvas.toDataURL('image/png');photo.alt=`${meta.displayName} cartoon avatar`;
    photo.classList.remove('hidden');fallback.classList.add('hidden');card.classList.remove('hidden');
  }
  $('close-card').addEventListener('click',()=>$('player-card').classList.add('hidden'));

  function setCylinderBetween(obj, a, b, radius = 1) {
    tmpV.subVectors(b, a); const len = tmpV.length();
    obj.position.copy(a).add(b).multiplyScalar(0.5);
    obj.quaternion.setFromUnitVectors(up, tmpV.normalize());
    obj.scale.set(radius, len, radius); obj.updateMatrix();
  }

  // ------------------------------------------------------------------ ball, trails and tactical marks
  function makeMatchBallTexture(){
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=320;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#f8f8f3';ctx.fillRect(0,0,640,320);
    ctx.strokeStyle='rgba(35,35,32,.28)';ctx.lineWidth=3;
    for(let y=0;y<=320;y+=64){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(640,y+32);ctx.stroke();}
    const pentagon=(cx,cy,r,rotation=0)=>{ctx.beginPath();for(let i=0;i<5;i++){const a=rotation-Math.PI/2+i*Math.PI*2/5,x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r;i?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.closePath();ctx.fillStyle='#17191a';ctx.fill();ctx.strokeStyle='#090a0b';ctx.lineWidth=3;ctx.stroke();};
    [[70,72,31,.2],[214,42,28,-.15],[390,70,33,.25],[565,45,27,0],[130,198,34,-.2],[318,158,38,.12],[510,205,34,.3],[230,292,29,0],[430,292,29,.2]].forEach(v=>pentagon(...v));
    ctx.strokeStyle='#d51d36';ctx.lineWidth=10;ctx.globalAlpha=.85;
    ctx.beginPath();ctx.arc(318,158,62,.15,1.5);ctx.stroke();ctx.beginPath();ctx.arc(130,198,55,3.2,4.6);ctx.stroke();ctx.globalAlpha=1;
    const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;texture.wrapS=T.RepeatWrapping;texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());return texture;
  }
  const ballGroup=new T.Group();
  const ball=new T.Mesh(new T.SphereGeometry(.22,32,20),new T.MeshStandardMaterial({map:makeMatchBallTexture(),color:0xffffff,roughness:.68,metalness:0}));
  ball.castShadow=true;ballGroup.add(ball);scene.add(ballGroup);
  const lastBallWorld=new T.Vector3(),ballAxis=new T.Vector3();let hasLastBallWorld=false;
  const shadow = new T.Mesh(new T.CircleGeometry(.42, 24), new T.MeshBasicMaterial({color:0x000000,transparent:true,opacity:.52,depthWrite:false}));
  shadow.rotation.x = -Math.PI/2; shadow.position.y = .018; scene.add(shadow);
  const possessionRing = new T.Mesh(new T.RingGeometry(.42,.58,28), new T.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.9,side:T.DoubleSide,blending:T.AdditiveBlending,depthWrite:false}));
  possessionRing.rotation.x = -Math.PI/2; possessionRing.position.y=.025; scene.add(possessionRing);

  const trailGeometry = new T.BufferGeometry();
  const trailMaterial = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .82, blending: T.AdditiveBlending, depthWrite: false });
  const trails = new T.LineSegments(trailGeometry, trailMaterial); trails.frustumCulled = false; scene.add(trails);
  let trailLength = C.TRAIL.def, lastTrailFrame = -1, trailsDirty = true;

  function historicalPoint(f, k, out) {
    if (!C.isPresent(data, f, k)) return false;
    const p = [0,0,0];
    if (!C.jointRaw(data, f, k, C.J.pelvis, p)) return false;
    out.set(p[0], p[2] + .045, -p[1]); return true;
  }
  function rebuildTrails(frame) {
    const positions=[], colors=[]; const a=new T.Vector3(), b=new T.Vector3();
    const start=Math.max(0,frame-trailLength);
    const add=(p0,p1,col,age0,age1)=>{
      positions.push(p0.x,p0.y,p0.z,p1.x,p1.y,p1.z);
      const c0=col.clone().multiplyScalar(.18+.82*C.alpha(age0,trailLength));
      const c1=col.clone().multiplyScalar(.18+.82*C.alpha(age1,trailLength));
      colors.push(c0.r,c0.g,c0.b,c1.r,c1.g,c1.b);
    };
    for(let k=0;k<data.K;k++){
      if (!layers.referees && data.entities[k].team===2) continue;
      const col=teamColors[data.entities[k].team]||neutralColor;
      for(let f=start;f<frame;f++) if(historicalPoint(f,k,a)&&historicalPoint(f+1,k,b)) add(a,b,col,frame-f,frame-f-1);
    }
    trailGeometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));
    trailGeometry.setAttribute('color',new T.Float32BufferAttribute(colors,3));
    trailGeometry.computeBoundingSphere(); lastTrailFrame=frame; trailsDirty=false;
  }

  // ------------------------------------------------------------------ UI state
  let layers = C.createLayers(); layers.skeletons = false;
  const switches = $('layer-switches');
  const pretty={players:'Cartoon players',skeletons:'Skeletons',trails:'Motion trails',ball:'Ball',pitchMarkings:'Pitch lines',labels:'Jersey labels',possession:'Possession',referees:'Officials',stadium:'Stadium',crowd:'Audience'};
  for(const name of C.LAYER_NAMES){
    const label=document.createElement('label'); label.className='switch';
    label.innerHTML=`<input type="checkbox" ${layers[name]?'checked':''} data-layer="${name}"><span>${pretty[name]}</span>`; switches.appendChild(label);
  }
  switches.addEventListener('change',(e)=>{
    const name=e.target.dataset.layer; if(!name)return;
    layers=C.toggleLayer(layers,name); trailsDirty=true;
  });
  $('trail-length').addEventListener('change',(e)=>{
    const result=C.parseTrailLength(e.target.value,trailLength); trailLength=result.value; e.target.value=trailLength;
    if(result.error){e.target.title=result.error;e.target.style.borderColor='#ff2d95';}else{e.target.title='';e.target.style.borderColor='';}
    trailsDirty=true;
  });
  $('panel-toggle').addEventListener('click',()=> $('panel').classList.toggle('panel-off'));

  const playback=C.createPlayback(data.F); playback.playing=true;
  const timeline=$('timeline'); timeline.max=String(data.F-1);
  const speedValues=[.25,.5,1,2,4];
  $('speed').addEventListener('change',(e)=>C.setSpeed(playback,speedValues[e.target.selectedIndex]));
  $('play').addEventListener('click',()=>{C.togglePlay(playback); updatePlayIcon();});
  $('step-back').addEventListener('click',()=>{C.step(playback,-1);updatePlayIcon();});
  timeline.addEventListener('input',(e)=>C.seek(playback,Number(e.target.value)));
  timeline.addEventListener('dblclick',()=>{C.step(playback,1);updatePlayIcon();});
  function updatePlayIcon(){$('play').textContent=playback.playing?'❚❚':'▶';}
  updatePlayIcon();

  // ------------------------------------------------------------------ camera and pointer controls
  let cameraMode='orbit', previousMode='orbit', povTarget=-1;
  const orbit=C.createOrbit();orbit.dist=130;orbit.el=.62;orbit.ty=1.5;
  let followPosition=new T.Vector3(20,18,24), noticeOverride='';
  function setMode(mode){
    if(mode==='pov'&&povTarget<0){noticeOverride='Click any player skeleton to enter POV';return;}
    if(cameraMode==='pov'&&mode!=='pov')povTarget=-1;
    if(mode!=='pov')previousMode=mode;
    cameraMode=mode; camera.up.set(0,1,0);
    document.querySelectorAll('.mode').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
    $('camera-value').textContent={orbit:'Orbit',follow:'Ball follow',topdown:'Tactical',pov:'Player POV'}[mode];
  }
  document.querySelectorAll('.mode').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));

  const pointer={down:false,button:0,x:0,y:0,startX:0,startY:0,moved:0};
  renderer.domElement.addEventListener('contextmenu',(e)=>e.preventDefault());
  renderer.domElement.addEventListener('pointerdown',(e)=>{
    pointer.down=true;pointer.button=e.button;pointer.x=pointer.startX=e.clientX;pointer.y=pointer.startY=e.clientY;pointer.moved=0;
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener('pointermove',(e)=>{
    if(pointer.down){
      const dx=e.clientX-pointer.x,dy=e.clientY-pointer.y;pointer.moved+=Math.hypot(dx,dy);pointer.x=e.clientX;pointer.y=e.clientY;
      if(cameraMode==='orbit'){
        if(pointer.button===0)C.orbitApply(orbit,-dx*.005,-dy*.005,0);
        else if(pointer.button===2){
          const scale=orbit.dist*.0015; orbit.tx-=dx*Math.cos(orbit.az)*scale; orbit.tz+=dx*Math.sin(orbit.az)*scale;
          orbit.tx+=dy*Math.sin(orbit.az)*scale; orbit.tz+=dy*Math.cos(orbit.az)*scale;
        }
      }
    }else hoverPick(e);
  });
  renderer.domElement.addEventListener('pointerup',(e)=>{
    if(pointer.down&&pointer.button===0&&pointer.moved<4&&cameraMode!=='pov')pickPerson(e,true);
    pointer.down=false;
  });
  renderer.domElement.addEventListener('wheel',(e)=>{if(cameraMode==='orbit'){e.preventDefault();C.orbitApply(orbit,0,0,Math.sign(e.deltaY));}},{passive:false});

  const raycaster=new T.Raycaster(), mouse=new T.Vector2(), tooltip=$('tooltip');
  function hitAt(e){
    const r=renderer.domElement.getBoundingClientRect(); mouse.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);
    raycaster.setFromCamera(mouse,camera);
    const hits=raycaster.intersectObjects([jointMesh,...avatarSprites],false);
    if(!hits.length)return -1;
    const hit=hits[0];return hit.object===jointMesh?(jointOwners[hit.instanceId]??-1):(hit.object.userData.entityIndex??-1);
  }
  function pickPerson(e,enter){
    const k=hitAt(e); if(k<0)return -1;
    if(enter){showPlayerCard(k);previousMode=cameraMode;povTarget=k;cameraMode='pov';setMode('pov');noticeOverride='';}
    return k;
  }
  function hoverPick(e){
    const k=hitAt(e); if(k<0){tooltip.classList.add('hidden');return;}
    const ent=data.entities[k],meta=playerMetadata[k];tooltip.textContent=`${meta.displayName} · #${ent.jersey} · click for POV`;tooltip.style.left=e.clientX+'px';tooltip.style.top=e.clientY+'px';tooltip.classList.remove('hidden');
  }

  addEventListener('keydown',(e)=>{
    if(/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))return;
    if(e.code==='Space'){e.preventDefault();C.togglePlay(playback);updatePlayIcon();}
    else if(e.code==='ArrowLeft'){e.preventDefault();C.step(playback,-1);updatePlayIcon();}
    else if(e.code==='ArrowRight'){e.preventDefault();C.step(playback,1);updatePlayIcon();}
    else if(e.code==='Escape'&&cameraMode==='pov'){const mode=previousMode;povTarget=-1;setMode(mode);}
  });

  // ------------------------------------------------------------------ per-frame updates
  const ballPitch=[0,0,0], posePoint=new T.Vector3(), aV=new T.Vector3(), bV=new T.Vector3();
  function updatePeople(frame,blend){
    let ji=0,bi=0,ai=0,hi=0;
    visiblePerson.fill(0);
    for(let k=0;k<data.K;k++){
      const ent=data.entities[k]; const allowed=layers.referees||ent.team!==2;
      const coords=jointsScratch[k],mask=masksScratch[k];
      const present=allowed&&C.personJoints(data,frame,blend,k,coords,mask);
      visiblePerson[k]=present?1:0;
      if(!present){labels[k].visible=false;avatarSprites[k].visible=false;continue;}
      const col=teamColors[ent.team]||neutralColor;
      // Label and aura use the highest available body anchor, preferably neck/pelvis.
      const anchor=mask[C.J.neck]?C.J.neck:(mask[C.J.pelvis]?C.J.pelvis:-1);
      if(anchor>=0){
        const b=anchor*3; const xyz=C.toThree(coords[b],coords[b+1],coords[b+2]);
        labels[k].position.set(xyz[0],xyz[1]+.92,xyz[2]); labels[k].visible=layers.labels&&!(cameraMode==='pov'&&k===povTarget);
      }else labels[k].visible=false;
      if(mask[C.J.pelvis]){
        const b=C.J.pelvis*3; const xyz=C.toThree(coords[b],coords[b+1],0);
        tmpObject.position.set(xyz[0],.025,xyz[2]);tmpObject.rotation.set(-Math.PI/2,0,0);tmpObject.scale.setScalar(1);tmpObject.updateMatrix();
        auraMesh.setMatrixAt(ai,tmpObject.matrix);auraMesh.setColorAt(ai,col);ai++;
      }
      // The face badge is anchored to tracked head keypoints and follows every movement.
      const face=[C.J.r_ear,C.J.l_ear,C.J.nose].filter(j=>mask[j]);
      let headXYZ=null;
      if(face.length){
        let hx=0,hy=0,hz=0;
        for(const j of face){const b=j*3;hx+=coords[b];hy+=coords[b+1];hz+=coords[b+2];}
        headXYZ=C.toThree(hx/face.length,hy/face.length,hz/face.length);
      }
      if(mask[C.J.pelvis]){
        const b=C.J.pelvis*3,xyz=C.toThree(coords[b],coords[b+1],coords[b+2]);
        avatarSprites[k].position.set(xyz[0],.94+Math.max(-.18,Math.min(.45,coords[b+2]-.8)),xyz[2]);
        avatarSprites[k].material.rotation=Math.sin((frame+k*5)*.16)*.025;
        avatarSprites[k].visible=layers.players&&!(cameraMode==='pov'&&k===povTarget);
      } else avatarSprites[k].visible=false;
      if(layers.skeletons && !(cameraMode==='pov'&&k===povTarget)){
        if(headXYZ){
          tmpObject.position.set(...headXYZ);tmpObject.quaternion.identity();tmpObject.scale.setScalar(1);tmpObject.updateMatrix();
          headMesh.setMatrixAt(hi,tmpObject.matrix);headMesh.setColorAt(hi,col);hi++;
        }
        for(let j=0;j<C.NJ;j++)if(mask[j]&&j!==C.J.r_ear&&j!==C.J.l_ear&&j!==C.J.nose){
          const b=j*3,xyz=C.toThree(coords[b],coords[b+1],coords[b+2]);
          tmpObject.position.set(xyz[0],xyz[1],xyz[2]);tmpObject.quaternion.identity();tmpObject.scale.setScalar(.075);tmpObject.updateMatrix();
          jointMesh.setMatrixAt(ji,tmpObject.matrix);jointMesh.setColorAt(ji,col);jointOwners[ji]=k;ji++;
        }
        for(const [ja,jb] of C.BONES)if(mask[ja]&&mask[jb]){
          let b=ja*3,xyz=C.toThree(coords[b],coords[b+1],coords[b+2]);aV.set(...xyz);
          b=jb*3;xyz=C.toThree(coords[b],coords[b+1],coords[b+2]);bV.set(...xyz);
          setCylinderBetween(tmpObject,aV,bV);boneMesh.setMatrixAt(bi,tmpObject.matrix);boneMesh.setColorAt(bi,col);bi++;
        }
      }
    }
    jointMesh.count=ji;boneMesh.count=bi;headMesh.count=hi;auraMesh.count=ai;
    jointMesh.visible=layers.skeletons;boneMesh.visible=layers.skeletons;headMesh.visible=layers.skeletons;auraMesh.visible=layers.players;
    jointMesh.instanceMatrix.needsUpdate=true;boneMesh.instanceMatrix.needsUpdate=true;headMesh.instanceMatrix.needsUpdate=true;auraMesh.instanceMatrix.needsUpdate=true;
    if(jointMesh.instanceColor)jointMesh.instanceColor.needsUpdate=true;
    if(boneMesh.instanceColor)boneMesh.instanceColor.needsUpdate=true;
    if(headMesh.instanceColor)headMesh.instanceColor.needsUpdate=true;
    if(auraMesh.instanceColor)auraMesh.instanceColor.needsUpdate=true;
  }

  function updateBallAndRing(frame,blend,hud){
    const exists=C.ballPose(data,frame,blend,ballPitch);
    ballGroup.visible=layers.ball&&exists;
    if(exists){
      const xyz=C.toThree(ballPitch[0],ballPitch[1],ballPitch[2]);ballGroup.position.set(...xyz);
      tmpV.set(...xyz);
      if(hasLastBallWorld){
        const dx=tmpV.x-lastBallWorld.x,dz=tmpV.z-lastBallWorld.z,distance=Math.hypot(dx,dz);
        if(distance>0.0001&&distance<2){ballAxis.set(dz,0,-dx).normalize();ball.rotateOnWorldAxis(ballAxis,distance/.22);}
      }
      lastBallWorld.copy(tmpV);hasLastBallWorld=true;
      shadow.visible=layers.ball&&C.shadowVisible(ballPitch[2]);shadow.position.set(xyz[0],.018,xyz[2]);
      const height=Math.max(0,ballPitch[2]);shadow.scale.setScalar(Math.min(2.2,.7+height*.08));shadow.material.opacity=Math.max(.12,.5-height*.025);
    }else {shadow.visible=false;hasLastBallWorld=false;}
    const target=layers.possession?C.ringTarget(data,frame):-1;
    possessionRing.visible=false;
    if(target>=0&&visiblePerson[target]&&masksScratch[target][C.J.pelvis]){
      const coords=jointsScratch[target],b=C.J.pelvis*3,xyz=C.toThree(coords[b],coords[b+1],0);
      possessionRing.position.set(xyz[0],.027,xyz[2]);possessionRing.material.color.copy(teamColors[data.entities[target].team]);possessionRing.visible=true;
      const pulse=1+Math.sin(performance.now()*.006)*.15;possessionRing.scale.setScalar(pulse);
    }
  }

  function updateHUD(frame,hud){
    $('frame-value').textContent=String(data.frameNumber[frame]);$('sequence-value').textContent=C.frameText(frame,data.F);
    $('possession-value').textContent=hud.possText;$('status-value').textContent=hud.statusText;$('people-value').textContent=String(hud.persons);$('time').textContent=C.elapsedText(frame);
    const card=$('possession-card');card.classList.toggle('home',hud.possText==='Home');card.classList.toggle('away',hud.possText==='Away');
    timeline.value=String(frame);
  }

  function showNotice(messages){
    const n=$('notice');const text=messages.filter(Boolean).join(' · ');n.textContent=text;n.classList.toggle('hidden',!text);
  }

  function updateCamera(frame,blend,dt,notices){
    if(cameraMode==='orbit'){
      const p=C.orbitPosition(orbit);camera.position.set(...p);camera.up.set(0,1,0);camera.lookAt(orbit.tx,orbit.ty,orbit.tz);
    }else if(cameraMode==='topdown'){
      camera.up.set(0,0,-1);camera.position.set(0,C.topDownHeight(camera.fov*Math.PI/180,camera.aspect),.001);camera.lookAt(0,0,0);
    }else if(cameraMode==='follow'){
      if(C.ballPose(data,frame,blend,ballPitch)){
        const xyz=C.toThree(ballPitch[0],ballPitch[1],ballPitch[2]);tmpV.set(...xyz);
        const desired=tmpV2.set(xyz[0]-13,xyz[1]+10,xyz[2]+16);followPosition.lerp(desired,C.followFactor(dt));camera.position.copy(followPosition);camera.up.set(0,1,0);camera.lookAt(tmpV);
      }else notices.push('Ball absent — camera held');
    }else if(cameraMode==='pov'){
      if(povTarget<0||!visiblePerson[povTarget])notices.push('POV target absent — camera held');
      else{
        const pose=C.povPose(jointsScratch[povTarget],masksScratch[povTarget]);
        if(!pose)notices.push('POV head data unavailable — camera held');
        else{
          const p=C.toThree(pose.pos[0],pose.pos[1],pose.pos[2]+.04);
          const q=C.toThree(pose.pos[0]+pose.fwd[0],pose.pos[1]+pose.fwd[1],pose.pos[2]+pose.fwd[2]+.04);
          camera.position.set(...p);camera.up.set(0,1,0);camera.lookAt(...q);
        }
      }
    }
  }

  let previousTime=performance.now();
  function animate(now){
    requestAnimationFrame(animate);
    const dt=Math.min(.1,Math.max(0,(now-previousTime)/1000));previousTime=now;
    C.advance(playback,dt*1000);
    const frame=C.frameIndex(playback),blend=C.blend(playback),notices=[];
    const hud=C.hudState(data,frame);
    updatePeople(frame,blend);updateBallAndRing(frame,blend,hud);updateHUD(frame,hud);
    if(data.ballMissing[frame])notices.push('Ball not tracked');
    if(noticeOverride){notices.push(noticeOverride);noticeOverride='';}
    updateCamera(frame,blend,dt,notices);showNotice(notices);
    markings.visible=layers.pitchMarkings;trails.visible=layers.trails;
    stadiumGroup.visible=layers.stadium;crowdRoot.visible=layers.crowd;
    crowdFlags.forEach((flag,i)=>{flag.rotation.z=Math.sin(now*.002+flag.userData.phase)*.035;flag.children[1].rotation.y=Math.sin(now*.004+flag.userData.phase)*.16;});
    if((frame!==lastTrailFrame||trailsDirty)&&layers.trails)rebuildTrails(frame);
    // Gentle holographic pulse without changing playback state.
    markGlowMaterial.opacity=.12+.07*(.5+.5*Math.sin(now*.0012));
    renderer.render(scene,camera);
  }

  addEventListener('resize',()=>{
    camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));
  });

  $('hud').classList.remove('hidden');$('controls').classList.remove('hidden');
  loader.classList.add('hidden');
  setMode('orbit');
  requestAnimationFrame(animate);
})();
