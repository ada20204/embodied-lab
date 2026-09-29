/* ===== Nova 运动学 · 碰撞 · 镜头编译 · 自动修正（纯 JS，无依赖） ===== */
var KIN=(function(){
'use strict';
const D2R=Math.PI/180,R2D=180/Math.PI;
/* 近似 Nova 5（UR 型标准 DH，单位 m） */
const DH={d:[0.24,0,0,0.135,0.12,0.09],a:[0,-0.42,-0.36,0,0,0],al:[Math.PI/2,0,0,Math.PI/2,-Math.PI/2,0]};
/* ---------- DJI Osmo Pocket 3（外形 139.7×42.2×33.5 mm，179 g） ----------
   Pocket 坐标系：原点=手柄底面中心，+Y 沿手柄向上，+Z=镜头朝向，屏幕在 -Z 面 */
const POCKET={w:0.0422,d:0.0335,handleH:0.1,lensY:0.1215,lensZ:0.013,mass:0.179};
const MOUNTS={
  bottom:{name:'底部安装（手柄沿法兰轴）',  // 转接板 12 mm，手柄轴 = 法兰 Z，镜头朝法兰 X
    R:[[0,0,1],[1,0,0],[0,1,0]],o:[0,0,0.012]},
  side:{name:'背夹正挂',     // 夹具夹住手柄背面，镜头朝法兰 Z，手柄在镜头下方
    R:[[-1,0,0],[0,-1,0],[0,0,1]],o:[0,0.04,0.012+0.0168]},
  invert:{name:'背夹倒挂（低机位）', // 手柄朝上、云台在下，画面后期旋转 180°
    R:[[1,0,0],[0,1,0],[0,0,1]],o:[0,-0.04,0.012+0.0168],flip:true}
};
// R 的列 = Pocket 的 X/Y/Z 轴在法兰系里的方向
function m4(Rm,o){return [Rm[0][0],Rm[0][1],Rm[0][2],o[0], Rm[1][0],Rm[1][1],Rm[1][2],o[1], Rm[2][0],Rm[2][1],Rm[2][2],o[2], 0,0,0,1];}
// 镜头光心系（相对相机头）：Z=视线(+Zp)，Y=画面向下(-Yp)，X=画面向右(-Xp)
const LENS0=m4([[-1,0,0],[0,-1,0],[0,0,1]],[0,0,POCKET.lensZ]);
let MOUNT='side',MOUNT_M=null,FLIP=false;
const FLIPZ=m4([[-1,0,0],[0,-1,0],[0,0,1]],[0,0,0]);
function setMount(k){MOUNT=k;const M=MOUNTS[k];MOUNT_M=m4(M.R,M.o);FLIP=!!M.flip;}
/* 三轴云台：平移(绕手柄轴 +Yp) → 横滚(绕视线) → 俯仰(绕 +Xp，正值=朝下)，三轴交于相机头中心。
   云台分担模式下，云台只做“起始角 → 结束角”的平滑转动（与镜头同一速度曲线），
   对应 Pocket 3 协议里的“带时长的绝对角度”指令。限位为保守值，接真机前请核对。 */
const GLIM=[[-90,90],[-30,60]];      // 平移、俯仰（度）
const GVMAX=120,GAMAX=600;           // 云台角速度/角加速度上限（度/秒、度/秒²，保守近似）
let GIMBAL=false;
function setGimbal(b){GIMBAL=!!b;}
function rotX(t){const c=Math.cos(t),s=Math.sin(t);return [1,0,0,0, 0,c,-s,0, 0,s,c,0, 0,0,0,1];}
function rotY(t){const c=Math.cos(t),s=Math.sin(t);return [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1];}
const LIM=[360,360,160,360,360,360];
const VMAX=[180,180,180,225,225,225];
const AMAX=[300,300,300,450,450,450];   // 关节加速度上限（度/秒²，保守近似）
const SING_MIN=0.3;                      // 腕部奇异余量 |sin q5| 下限
const LAYOUT={product:[0.62,0,0],bottleR:0.042,bottleH:0.19,wallGap:0.55,baseR:0.085,baseH:0.2};
const TARGET=[0,0,0.09];
function setProduct(x,y){LAYOUT.product=[x,y,0];TARGET[0]=x;TARGET[1]=y;}
function wallN(){const p=LAYOUT.product,l=Math.hypot(p[0],p[1])||1;return [p[0]/l,p[1]/l,0];}
function facing(){const p=LAYOUT.product;return Math.atan2(-p[1],-p[0])*R2D;}
setProduct(0.62,0);

const I4=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function dh(th,d,a,al){const ct=Math.cos(th),st=Math.sin(th),ca=Math.cos(al),sa=Math.sin(al);
  return [ct,-st*ca,st*sa,a*ct, st,ct*ca,-ct*sa,a*st, 0,sa,ca,d, 0,0,0,1];}
function mul(A,B){const C=new Array(16);for(let r=0;r<4;r++)for(let c=0;c<4;c++){C[r*4+c]=A[r*4]*B[c]+A[r*4+1]*B[4+c]+A[r*4+2]*B[8+c]+A[r*4+3]*B[12+c];}return C;}
function trans(x,y,z){return [1,0,0,x,0,1,0,y,0,0,1,z,0,0,0,1];}
function fk(q,g){const F=[I4];let T=I4;for(let i=0;i<6;i++){T=mul(T,dh(q[i],DH.d[i],DH.a[i],DH.al[i]));F.push(T);}
  const pan=g?g[0]:(q[6]||0),tilt=g?g[1]:(q[7]||0);
  const Pm=mul(T,MOUNT_M),g0=mul(Pm,trans(0,POCKET.lensY,0)),g3=mul(mul(g0,rotY(pan)),rotX(tilt));
  let L=mul(g3,LENS0);if(FLIP)L=mul(L,FLIPZ);F.push(L);F.Pm=Pm;F.head=P(g0);F.headM=g3;return F;}
const P=T=>[T[3],T[7],T[11]],COL=(T,c)=>[T[c],T[4+c],T[8+c]];
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],add=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const scl=(a,s)=>[a[0]*s,a[1]*s,a[2]*s],dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const nrm=a=>Math.hypot(a[0],a[1],a[2]),unit=a=>{const n=nrm(a)||1;return scl(a,1/n);};
const lerp=(a,b,t)=>a+(b-a)*t;
function tool(T,v){return add(P(T),add(add(scl(COL(T,0),v[0]),scl(COL(T,1),v[1])),scl(COL(T,2),v[2])));}

function poseErr(Tc,Td){
  const ep=[Td[3]-Tc[3],Td[7]-Tc[7],Td[11]-Tc[11]];
  const R=[[0,0,0],[0,0,0],[0,0,0]];
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)R[i][j]=Td[i*4]*Tc[j*4]+Td[i*4+1]*Tc[j*4+1]+Td[i*4+2]*Tc[j*4+2];
  const tr=R[0][0]+R[1][1]+R[2][2];const ang=Math.acos(Math.max(-1,Math.min(1,(tr-1)/2)));
  const v=[R[2][1]-R[1][2],R[0][2]-R[2][0],R[1][0]-R[0][1]];
  const s=Math.sin(ang);const f=ang<1e-6?0.5:ang/(2*Math.max(s,1e-3));
  return {ep,w:scl(v,f),ang};
}
function solve6(A,b){const n=6,M=A.map((r,i)=>r.concat([b[i]]));
  for(let c=0;c<n;c++){let p=c;for(let r=c+1;r<n;r++)if(Math.abs(M[r][c])>Math.abs(M[p][c]))p=r;
    const t=M[c];M[c]=M[p];M[p]=t;const d=M[c][c]||1e-12;
    for(let r=0;r<n;r++){if(r===c)continue;const f=M[r][c]/d;if(!f)continue;for(let k=c;k<=n;k++)M[r][k]-=f*M[c][k];}}
  return M.map((r,i)=>r[n]/(r[i]||1e-12));}
const WR=0.3;
function ik(Td,q0,iters,g){
  const q=q0.slice(0,6);let F,e;
  for(let it=0;it<iters;it++){
    F=fk(q,g);e=poseErr(F[7],Td);
    if(nrm(e.ep)<1e-5&&e.ang<1e-4)break;
    const pe=P(F[7]);const J=[[],[],[],[],[],[]];
    for(let i=0;i<6;i++){const z=COL(F[i],2),o=P(F[i]);const jv=cross(z,sub(pe,o));
      J[0][i]=jv[0];J[1][i]=jv[1];J[2][i]=jv[2];J[3][i]=z[0]*WR;J[4][i]=z[1]*WR;J[5][i]=z[2]*WR;}
    const err=[e.ep[0],e.ep[1],e.ep[2],e.w[0]*WR,e.w[1]*WR,e.w[2]*WR];
    const A=[];for(let r=0;r<6;r++){A.push([]);for(let c=0;c<6;c++){let s=0;for(let k=0;k<6;k++)s+=J[r][k]*J[c][k];A[r].push(s+(r===c?0.0004:0));}}
    const y=solve6(A,err);let dq=[0,0,0,0,0,0];
    for(let i=0;i<6;i++){let s=0;for(let r=0;r<6;r++)s+=J[r][i]*y[r];dq[i]=s;}
    const n=Math.hypot(...dq);if(n>0.25)dq=dq.map(v=>v*0.25/n);
    for(let i=0;i<6;i++)q[i]+=dq[i];
  }
  F=fk(q,g);e=poseErr(F[7],Td);
  return {q,F,pe:nrm(e.ep),re:e.ang};
}

/* ---------- 镜头语法 ---------- */
/* 所有速度曲线都从静止起步、回到静止：速度剖面 = S 形加速段 + 匀速段 + S 形减速段 */
function buildEase(ra,rd){const N=1000,sm=x=>x*x*(3-2*x),v=[],c=[0];
  for(let i=0;i<=N;i++){const u=i/N;v.push(u<ra?sm(u/ra):u>1-rd?sm((1-u)/rd):1);}
  for(let i=1;i<=N;i++)c.push(c[i-1]+(v[i]+v[i-1])/2);const T=c[N];return c.map(x=>x/T);}
const EASE={linear:buildEase(0.15,0.15),out:buildEase(0.1,0.55),in:buildEase(0.55,0.1)};
function ease(u,k){if(k==='smooth'||!EASE[k])return u*u*u*(u*(u*6-15)+10);
  const t=EASE[k],f=Math.max(0,Math.min(1,u))*1000,i=Math.min(999,Math.floor(f));return t[i]+(t[i+1]-t[i])*(f-i);}
function lookPose(pos,look,upHint){
  const f=unit(sub(look,pos));let r=cross(f,upHint);if(nrm(r)<1e-6)r=cross(f,[1,0,0]);r=unit(r);const u=cross(r,f);
  return [r[0],-u[0],f[0],pos[0], r[1],-u[1],f[1],pos[1], r[2],-u[2],f[2],pos[2], 0,0,0,1];
}
function gimbalAt(S,u){if(!GIMBAL||!S.gim)return [0,0];const e=ease(u,S.ease),G=S.gim;return [lerp(G.p0,G.p1,e)*D2R,lerp(G.t0,G.t1,e)*D2R];}
function shotPose(S,u){
  const e=ease(u,S.ease),T=TARGET,Z=[0,0,1],p=S.p;
  if(S.type==='orbit'){const a=lerp(p.a0,p.a1,e)*D2R;
    return lookPose([T[0]+p.r*Math.cos(a),T[1]+p.r*Math.sin(a),T[2]+p.h],T,Z);}
  if(S.type==='dolly'){const a=p.az*D2R,d=lerp(p.d0,p.d1,e);
    return lookPose([T[0]+d*Math.cos(a),T[1]+d*Math.sin(a),T[2]+p.h],T,Z);}
  if(S.type==='reveal'){const a=lerp(p.az0,p.az1,e)*D2R,h=lerp(p.h0,p.h1,e);
    return lookPose([T[0]+p.r*Math.cos(a),T[1]+p.r*Math.sin(a),T[2]+h],[T[0],T[1],T[2]+Math.max(0,h)*0.35],Z);}
  const s=lerp(p.s0,p.s1,e)*D2R;
  return lookPose([T[0],T[1],T[2]+p.h],T,[-Math.cos(s),-Math.sin(s),0]);
}

/* ---------- 碰撞：机械臂胶囊体 vs 环境 + 自碰撞 ---------- */
const PART=['大臂','小臂','腕1','腕2','腕3','Pocket 手柄','Pocket 云台'];
function capsules(F){
  const c=[];
  c.push({a:P(F[1]),b:P(F[2]),r:0.052});           // 0 大臂
  c.push({a:P(F[2]),b:P(F[3]),r:0.046});           // 1 小臂
  c.push({a:P(F[3]),b:P(F[4]),r:0.042});           // 2 腕1
  c.push({a:P(F[4]),b:P(F[5]),r:0.04});            // 3 腕2
  c.push({a:P(F[5]),b:P(F[6]),r:0.038});           // 4 腕3
  const Pm=F.Pm;
  c.push({a:tool(Pm,[0,0.012,0]),b:tool(Pm,[0,0.09,0]),r:0.0235});                  // 5 Pocket 手柄（含外接圆）
  c.push({a:F.head,b:tool(Pm,[0,0.108,-0.004]),r:0.022});                           // 6 云台+相机头（转动包络）
  return c;
}
function segSeg(p1,q1,p2,q2){ // 两线段最近距离
  const d1=sub(q1,p1),d2=sub(q2,p2),r=sub(p1,p2);const a=dot(d1,d1),e=dot(d2,d2),f=dot(d2,r);let s,t;
  if(a<1e-12&&e<1e-12)return nrm(r);
  if(a<1e-12){s=0;t=Math.max(0,Math.min(1,f/e));}else{const c=dot(d1,r);
    if(e<1e-12){t=0;s=Math.max(0,Math.min(1,-c/a));}else{const b=dot(d1,d2),den=a*e-b*b;
      s=den>1e-12?Math.max(0,Math.min(1,(b*f-c*e)/den)):0;t=(b*s+f)/e;
      if(t<0){t=0;s=Math.max(0,Math.min(1,-c/a));}else if(t>1){t=1;s=Math.max(0,Math.min(1,(b-c)/a));}}}
  return nrm(sub(add(p1,scl(d1,s)),add(p2,scl(d2,t))));
}
const MARGIN=0.02;
function collisionMask(F){
  const C=capsules(F),L=LAYOUT;let m=0;
  const bottleA=[L.product[0],L.product[1],0],bottleB=[L.product[0],L.product[1],L.bottleH];
  const baseA=[0,0,0],baseB=[0,0,L.baseH];
  C.forEach((c,i)=>{
    if(Math.min(c.a[2],c.b[2])-c.r<0.01)m|=1<<i;                                   // 台面
    if(segSeg(c.a,c.b,bottleA,bottleB)<c.r+L.bottleR+MARGIN)m|=1<<i;               // 产品
    {const n=wallN();const w=dot(L.product,n)+L.wallGap;if(Math.max(dot(c.a,n),dot(c.b,n))+c.r>w-MARGIN)m|=1<<i;} // 背景墙
    if(i>=1&&segSeg(c.a,c.b,baseA,baseB)<c.r+L.baseR+MARGIN)m|=1<<i;              // 底座
  });
  const pairs=[[0,3],[0,4],[0,5],[0,6],[1,4],[1,5],[1,6],[2,6]];                               // 自碰撞
  for(const [i,j] of pairs)if(segSeg(C[i].a,C[i].b,C[j].a,C[j].b)<C[i].r+C[j].r+0.01){m|=1<<i;m|=1<<j;}
  return m;
}
function clearance(F){ // 机械臂到产品/台面/底座/墙的最小间隙（m，已扣半径）
  const C=capsules(F),L=LAYOUT,n=wallN(),w=dot(L.product,n)+L.wallGap;let g=Infinity;
  const bA=[L.product[0],L.product[1],0],bB=[L.product[0],L.product[1],L.bottleH];
  C.forEach((c,i)=>{g=Math.min(g,Math.min(c.a[2],c.b[2])-c.r,segSeg(c.a,c.b,bA,bB)-c.r-L.bottleR,w-Math.max(dot(c.a,n),dot(c.b,n))-c.r);
    if(i>=1)g=Math.min(g,segSeg(c.a,c.b,[0,0,0],[0,0,L.baseH])-c.r-L.baseR);});
  return g;
}
function singular(q,F){
  if(Math.abs(Math.sin(q[4]))<SING_MIN)return true;
  if(Math.abs(Math.sin(q[2]))<0.12)return true;
  const w=P(F[5]);return Math.hypot(w[0],w[1])<0.08;
}
const BIT={unreach:1,collide:2,limit:4,speed:8,accel:32,shock:64,sing:16};
const ERRM=1|2|4,WARNM=8|16|32|64;

/* ---------- 编译：整条路径选最优逆解分支 ---------- */
function seedsFor(T0){
  const b=Math.atan2(T0[7],T0[3]),S=[];
  for(const bb of [b,b+Math.PI])for(const s2 of [-1,1])for(const w of [-1,1])
    S.push([bb,s2<0?-1.3:-1.9,s2<0?1.9:-1.9,s2<0?-2.2:-1.0,w*1.57,0]);
  return S;
}
function runPath(S,q0,dt,pct){
  const n=Math.max(2,Math.round(S.dur/dt)+1);
  const vlim=VMAX.concat([GVMAX,GVMAX]).map(v=>v*pct/100*D2R),alim=AMAX.concat([GAMAX,GAMAX]).map(a=>a*pct/100*D2R);
  const qs=[],st=new Array(n).fill(0),cm=new Array(n).fill(0),peak=new Array(8).fill(0);let prev=q0.slice(0,6).concat(gimbalAt(S,0)),minClr=Infinity,minSin=1;
  for(let i=0;i<n;i++){
    const u=i/(n-1),Td=shotPose(S,u),g=gimbalAt(S,u);const r=ik(Td,prev,i===0?160:60,g);r.q=r.q.concat(g);let s=0;
    if(r.pe>0.002||r.re>0.01)s|=BIT.unreach;
    for(let j=0;j<6;j++)if(Math.abs(r.q[j])>LIM[j]*D2R)s|=BIT.limit;
    const m=collisionMask(r.F);if(m){s|=BIT.collide;cm[i]=m;}if(!(s&BIT.unreach))minClr=Math.min(minClr,clearance(r.F));
    if(singular(r.q,r.F))s|=BIT.sing;
    if(i>0)for(let j=0;j<8;j++){const v=Math.abs(r.q[j]-prev[j])/dt;peak[j]=Math.max(peak[j],v);if(v>vlim[j])s|=BIT.speed;}
    minSin=Math.min(minSin,Math.abs(Math.sin(r.q[4])));
    st[i]=s;qs.push(r.q);prev=r.q;
  }
  // 加速度（首尾按从静止起步/回到静止计算）与起停冲击
  const vel=i=>i<=0||i>=n?new Array(8).fill(0):qs[i].map((x,j)=>(x-qs[i-1][j])/dt);
  const apeak=new Array(8).fill(0);
  for(let i=1;i<=n;i++){const v0=vel(i-1),v1=vel(i);for(let j=0;j<8;j++){const a=Math.abs(v1[j]-v0[j])/dt;apeak[j]=Math.max(apeak[j],a);
    if(a>alim[j])st[Math.min(i,n-1)]|=BIT.accel;}}
  const SHOCK=5*D2R,v0=vel(1),vN=vel(n-1);
  if(v0.some(v=>Math.abs(v)>SHOCK))st[0]|=BIT.shock;
  if(vN.some(v=>Math.abs(v)>SHOCK))st[n-1]|=BIT.shock;
  const errN=st.filter(s=>s&ERRM).length,warnN=st.filter(s=>(s&WARNM)&&!(s&ERRM)).length;
  let travel=0,wristTravel=0;for(let i=1;i<n;i++){for(let j=0;j<6;j++)travel+=Math.abs(qs[i][j]-qs[i-1][j]);for(let j=3;j<6;j++)wristTravel+=Math.abs(qs[i][j]-qs[i-1][j]);}
  const wristPk=Math.max(peak[3],peak[4],peak[5])*R2D;
  const quality=30*Math.max(0,0.45-minSin)+300*Math.max(0,0.06-(isFinite(minClr)?minClr:0))+wristPk/20+travel*0.5;
  return {n,qs,st,cm,peak,apeak,vlim,alim,errN,warnN,travel,wristTravel,minClr,minSin,wristPk,quality,v0,vN,dur:S.dur,dt};
}
function score(R){return R.errN*1000+R.warnN*10+R.quality;}
function compile(S,dt,pct){
  const T0=shotPose(S,0),g0=gimbalAt(S,0);let best=null;
  const wrap=v=>Math.atan2(Math.sin(v),Math.cos(v));
  const starts=seedsFor(T0).map(sd=>ik(T0,sd,160,g0)).filter(r=>r.pe<1e-3&&r.re<0.01).map(r=>({q:r.q.map(wrap)}));
  const uniq=[];for(const r of starts){if(!uniq.some(u=>u.q.every((v,j)=>Math.abs(Math.atan2(Math.sin(v-r.q[j]),Math.cos(v-r.q[j])))<0.05)))uniq.push(r);}
  const cands=uniq.length?uniq.map(r=>r.q):seedsFor(T0);
  for(const q0 of cands){const R=runPath(S,q0,dt,pct);if(!best||score(R)<score(best))best=R;}
  const des=[];for(let i=0;i<best.n;i++)des.push(P(shotPose(S,i/(best.n-1))));
  best.des=des;
  best.count={};for(const k in BIT)best.count[k]=best.st.filter(s=>s&BIT[k]).length;
  return best;
}

/* ---------- 自动修正：在参数空间里找最接近原镜头的可执行版本 ---------- */
const SPACE={
  orbit:{r:[0.14,0.45,0.02],h:[-0.04,0.3,0.02],a0:[-180,540,10],a1:[-180,540,10]},
  dolly:{az:[0,360,10],d0:[0.14,0.6,0.02],d1:[0.14,0.6,0.02],h:[-0.04,0.3,0.02]},
  reveal:{az0:[0,360,10],az1:[0,360,10],r:[0.14,0.45,0.02],h0:[-0.04,0.3,0.02],h1:[-0.04,0.3,0.02]},
  top:{h:[0.16,0.45,0.02],s0:[-180,180,10],s1:[-180,360,10]}
};
function repairOne(S,pct){
  const space=SPACE[S.type],keys=Object.keys(space),orig=Object.assign({},S.p);
  // 改变构图的参数（距离）代价高，高度次之；角度按 10° 一档
  const W={r:4,d0:4,d1:4,h:1.2,h0:1.2,h1:1.2};
  const dev=p=>keys.reduce((a,k)=>a+Math.abs(p[k]-orig[k])/space[k][2]*(W[k]||1.5),0);
  const evalP=p=>{const R=compile(Object.assign({},S,{p}),0.1,pct);return {R,f:R.errN*1000+R.warnN*40+dev(p)*1.5+R.quality};};
  let cur=Object.assign({},orig),cv=evalP(cur),evals=1;
  for(let round=0;round<4;round++){let improved=false;
    for(const k of keys){const [lo,hi,st]=space[k];
      for(const m of [1,-1,2,-2,4,-4,7,-7]){const v=Math.round((cur[k]+m*st)/st)*st;if(v<lo-1e-9||v>hi+1e-9)continue;
        const p=Object.assign({},cur,{[k]:+v.toFixed(3)});const pv=evalP(p);evals++;
        if(pv.f<cv.f-1e-6){cur=p;cv=pv;improved=true;}}}
    if(!improved)break;}
  // 剩余超速：拉长时长
  let dur=S.dur;const R=compile(Object.assign({},S,{p:cur}),0.02,pct);
  const k=Math.max(...R.peak.map((v,j)=>v/R.vlim[j]),...R.apeak.map((a,j)=>Math.sqrt(a/R.alim[j])));
  if(k>1)dur=Math.min(20,Math.ceil(S.dur*k*1.1*2)/2);
  return {p:cur,dur,evals,f:cv.f,devCost:dev(cur)*1.5,ok:R.errN+R.warnN===0};
}
function repair(S,pct){
  const m0=MOUNT;let best=Object.assign(repairOne(S,pct),{mount:m0});let evals=best.evals;
  // 当前安装方式修不好，或者要大改构图才能过，就试试换安装方式（换安装也算一次改动）
  if(!best.ok||best.devCost>6){for(const m of Object.keys(MOUNTS)){if(m===m0)continue;setMount(m);
    const r=repairOne(S,pct);evals+=r.evals;if((r.ok||!best.ok)&&r.f+5<best.f)best=Object.assign(r,{mount:m});}
    setMount(best.mount);}
  best.evals=evals;return best;
}

/* ---------- 云台分担：搜索云台起止角，让机械臂最从容 ---------- */
function planGimbal(S,pct){
  const cur=Object.assign({p0:0,t0:0,p1:0,t1:0},S.gim||{}),keys=['p0','p1','t0','t1'],lim={p0:GLIM[0],p1:GLIM[0],t0:GLIM[1],t1:GLIM[1]};
  const was=GIMBAL;GIMBAL=true;
  const cost=G=>{const R=compile(Object.assign({},S,{gim:G}),0.1,pct);
    return R.errN*1000+R.warnN*40+R.quality+(Math.abs(G.p0)+Math.abs(G.p1)+Math.abs(G.t0)+Math.abs(G.t1))*0.01;};
  let best=cur,bv=cost(cur),evals=1;
  for(let round=0;round<4;round++){let imp=false;
    for(const k of keys)for(const d of [30,-30,15,-15,5,-5]){const v=best[k]+d;if(v<lim[k][0]||v>lim[k][1])continue;
      const G=Object.assign({},best,{[k]:v});const c=cost(G);evals++;if(c<bv-1e-6){best=G;bv=c;imp=true;}}
    // 起止同时平移（整体偏转）
    for(const [a,b] of [['p0','p1'],['t0','t1']])for(const d of [20,-20,10,-10]){const G=Object.assign({},best,{[a]:best[a]+d,[b]:best[b]+d});
      if(G[a]<lim[a][0]||G[a]>lim[a][1]||G[b]<lim[b][0]||G[b]>lim[b][1])continue;const c=cost(G);evals++;if(c<bv-1e-6){best=G;bv=c;imp=true;}}
    if(!imp)break;}
  GIMBAL=was;return {gim:best,evals};
}

setMount('side');
return {GLIM,GVMAX,setGimbal,getGimbal:()=>GIMBAL,planGimbal,gimbalAt,POCKET,MOUNTS,setMount,getMount:()=>MOUNT,mountMatrix:()=>MOUNT_M,mul,AMAX,SING_MIN,setProduct,wallN,facing,D2R,R2D,DH,LIM,VMAX,LAYOUT,TARGET,fk,P,COL,tool,capsules,shotPose,compile,repair,BIT,ERRM,WARNM,PART,SPACE};
})();
if(typeof module!=='undefined')module.exports=KIN;
