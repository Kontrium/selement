/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from "react";
import { ShieldCheck, Eye, EyeOff, Swords, Compass, Map, Lock, Zap, Sparkles, Flame, Wind } from "lucide-react";
import { BiomeType, BiomeConfig, MapSettings, PlayerState, SpawnPoint } from "../types";
import { ref, onValue, set, remove, update, onChildAdded } from "firebase/database";
import { db } from "../lib/firebase";

// Biome Colors and config matching original design
export const BIOMES: Record<BiomeType, BiomeConfig> = {
  WATER: { id: 0, c1: "#1f618d", c2: "#2e86c1", name: "Woda" },
  SAND: { id: 1, c1: "#f1c40f", c2: "#f39c12", name: "Pustynia" },
  GRASS: { id: 2, c1: "#4caf50", c2: "#45a049", name: "Łąka" },
  FOREST: { id: 3, c1: "#1e8449", c2: "#196f3d", name: "Las" },
  RAINFOREST: { id: 4, c1: "#117a65", c2: "#0e6251", name: "Las Deszczowy" },
  MOUNTAIN: { id: 5, c1: "#7f8c8d", c2: "#95a5a6", name: "Góry" }
};

interface GameCanvasProps {
  mapSettings: MapSettings;
  charClass: "mag" | "wojownik" | "lucznik";
  currentUser: string;
  isAdminActive: boolean;
  editorTool: "none" | "paint" | "add_spawn";
  selectedBiome: BiomeType;
  selectedSpawnType: string;
  onMapTileCustomized: (tileKey: string, type: BiomeType) => void;
  onSpawnPointAdded: (spawn: SpawnPoint) => void;
  onGameStatsUpdated: (level: number, score: number) => void;
}

// Procedural noise algorithm matching the original formula
export function getNoiseTileAt(x: number, y: number, mapW: number, mapH: number): BiomeType {
  // Wrap coordinate inside map boundary widths
  const boundedX = ((x % mapW) + mapW) % mapW;
  const boundedY = ((y % mapH) + mapH) % mapH;

  const getSmoothNoise = (tx: number, ty: number) => {
    let total = 0;
    total += (Math.sin(tx * 0.05) + Math.cos(ty * 0.05)) * 2.0;
    total += (Math.sin(tx * 0.15) * Math.cos(ty * 0.12)) * 1.0;
    total += (Math.sin(tx * 0.01) + Math.sin(ty * 0.01)) * 4.0;
    return total;
  };

  const n = getSmoothNoise(boundedX, boundedY);
  const riverNoise = Math.abs(Math.sin(boundedX * 0.08) + Math.cos(boundedY * 0.08));

  if (n < -2.2 || riverNoise < 0.08) return "WATER";
  if (n < -1.2) return "SAND";
  if (n < 0.8) return "GRASS";
  if (n < 2.2) return "FOREST";
  if (n < 3.8) return "RAINFOREST";
  return "MOUNTAIN";
}

export function MathNoise(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453123;
  return n - Math.floor(n);
}

export default function GameCanvas({
  mapSettings,
  charClass,
  currentUser,
  isAdminActive,
  editorTool,
  selectedBiome,
  selectedSpawnType,
  onMapTileCustomized,
  onSpawnPointAdded,
  onGameStatsUpdated
}: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Score metrics
  const [score, setScore] = useState(0);

  // Hero parameters in state to render on React HUD easily
  const [playerHp, setPlayerHp] = useState(100);
  const [playerMaxHp, setPlayerMaxHp] = useState(100);
  const [playerMana, setPlayerMana] = useState(100);
  const [playerMaxMana, setPlayerMaxMana] = useState(100);
  const [playerLvl, setPlayerLvl] = useState(1);
  const [playerXp, setPlayerXp] = useState(0);
  const [playerXpNeeded, setPlayerXpNeeded] = useState(100);

  // Spell states
  const [selectedSpell, setSelectedSpell] = useState<1 | 2 | 3>(1);
  const [spell1Cooldown, setSpell1Cooldown] = useState(0);
  const [spell2Cooldown, setSpell2Cooldown] = useState(0);
  const [spell3Cooldown, setSpell3Cooldown] = useState(0);
  const [dashCooldown, setDashCooldown] = useState(0);

  const castSpellRef = useRef<((id: 1 | 2 | 3) => void) | null>(null);
  const triggerDashRef = useRef<(() => void) | null>(null);
  const selectedSpellRef = useRef<1 | 2 | 3>(1);

  // Keep the ref in sync with selected spell for canvas keyboard checks
  useEffect(() => {
    selectedSpellRef.current = selectedSpell;
  }, [selectedSpell]);

  // Weather parameters
  const [currentWeather, setCurrentWeather] = useState("sunny");
  const [bossUiActive, setBossUiActive] = useState(false);
  const [bossHpPercentage, setBossHpPercentage] = useState(100);

  // Core character development states
  const [playerStamina, setPlayerStamina] = useState(100);
  const [playerMaxStamina, setPlayerMaxStamina] = useState(100);
  const [isRunning, setIsRunning] = useState(false);
  const [statPoints, setStatPoints] = useState(0);
  const [statStrength, setStatStrength] = useState(0);
  const [statEnergy, setStatEnergy] = useState(0);
  const [statLife, setStatLife] = useState(0);
  const [statStaminaStat, setStatStaminaStat] = useState(0);
  const [statSpeed, setStatSpeed] = useState(0);

  // References to invoke handlers inside event loop / handlers securely
  const toggleRunningRef = useRef<(() => void) | null>(null);
  const allocateStatRef = useRef<((statName: "strength" | "energy" | "life" | "stamina" | "speed") => void) | null>(null);

  // Minimap toggles and synchronization indicators for non-render access
  const [isFullScreenMinimap, setIsFullScreenMinimap] = useState(false);
  const isFullScreenMinimapRef = useRef(false);
  isFullScreenMinimapRef.current = isFullScreenMinimap;
  const playerRef = useRef({ worldX: 0, worldY: 0 });
  const otherPlayersRef = useRef<Record<string, any>>({});
  const enemiesRef = useRef<any[]>([]);

  // References to keep state accessible immediately in high-frequency event loop (up to 120 FPS)
  const statsRef = useRef({
    score: 0,
    level: 1,
    xp: 0,
    xpNeeded: 100,
    hp: 100,
    maxHp: 100,
    mana: 100,
    maxMana: 100
  });

  // Track spawn intervals
  const mapSettingsRef = useRef(mapSettings);
  mapSettingsRef.current = mapSettings;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animFrameId: number;
    let isRunning = true;

    // Canvas size
    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();

    const TILE_SIZE = 64;

    // Entities simulation lists
    const bullets: any[] = [];
    const enemyBullets: any[] = [];
    const enemies: any[] = [];
    const animals: any[] = [];
    const loots: any[] = [];
    const fishes: any[] = [];
    const visualEffects: any[] = [];
    const particles: any[] = [];

    // Local skills & dash parameters inside loop context
    let dashCooldown = 0;
    let dashActiveTimer = 0;
    let dashDirectionX = 0;
    let dashDirectionY = 0;

    let skill1Cooldown = 0;
    let skill2Cooldown = 0;
    let skill3Cooldown = 0;
    let windriderActiveTimer = 0;

    // Real-time Firebase Multiplayer synchronization data
    let otherPlayers: Record<string, any> = {};
    let syncThrottle = 0;
    const playersRef = ref(db, "players");

    const unsubscribePlayers = onValue(playersRef, (snapshot) => {
      if (!isRunning) return;
      if (snapshot.exists()) {
        const val = snapshot.val();
        const filtered: Record<string, any> = {};
        const now = Date.now();
        for (const key in val) {
          if (key !== currentUser) {
            if (now - val[key].lastUpdate < 12000) {
              filtered[key] = val[key];
            }
          }
        }
        otherPlayers = filtered;
      } else {
        otherPlayers = {};
      }
    });

    const isHost = () => {
      const activeUsernames = Object.keys(otherPlayers).concat(currentUser).sort();
      return activeUsernames[0] === currentUser;
    };

    const monstersRef = ref(db, "monsters");
    const unsubscribeMonsters = onValue(monstersRef, (snapshot) => {
      if (!isRunning) return;
      if (!isHost()) {
        if (snapshot.exists()) {
          const val = snapshot.val();
          const list: any[] = [];
          for (const key in val) {
            list.push({ id: key, ...val[key] });
          }
          enemies.length = 0;
          enemies.push(...list);
        } else {
          enemies.length = 0;
        }
      }
    });

    const dbAnimalsRef = ref(db, "animals");
    const unsubscribeAnimals = onValue(dbAnimalsRef, (snapshot) => {
      if (!isRunning) return;
      if (!isHost()) {
        if (snapshot.exists()) {
          const val = snapshot.val();
          const list: any[] = [];
          for (const key in val) {
            list.push({ id: key, ...val[key] });
          }
          animals.length = 0;
          animals.push(...list);
        } else {
          animals.length = 0;
        }
      }
    });

    const dbLootsRef = ref(db, "loots");
    const unsubscribeLoots = onValue(dbLootsRef, (snapshot) => {
      if (!isRunning) return;
      if (snapshot.exists()) {
        const val = snapshot.val();
        const list: any[] = [];
        for (const key in val) {
          list.push({ id: key, ...val[key] });
        }
        loots.length = 0;
        loots.push(...list);
      } else {
        loots.length = 0;
      }
    });

    const activeBulletsRef = ref(db, "bullets/active");
    const unsubscribeBulletSpawns = onChildAdded(activeBulletsRef, (snapshot) => {
      if (!isRunning) return;
      const b = snapshot.val();
      if (b && b.shooter !== currentUser) {
        if (b.type === "slash") {
          visualEffects.push({
            type: "slash",
            worldX: b.worldX,
            worldY: b.worldY,
            angle: b.angle,
            side: b.side || 1,
            life: b.life,
            maxLife: b.maxLife || 12
          });
        } else if (b.type === "frost_nova") {
          visualEffects.push({
            type: "frost_nova",
            worldX: b.worldX,
            worldY: b.worldY,
            radius: 10,
            maxRadius: 130,
            life: b.life,
            maxLife: 25
          });
        } else if (b.type === "ground_slam") {
          visualEffects.push({
            type: "ground_slam",
            worldX: b.worldX,
            worldY: b.worldY,
            radius: 10,
            maxRadius: 125,
            life: b.life,
            maxLife: 25
          });
        } else if (b.type === "blade_whirl") {
          visualEffects.push({
            type: "blade_whirl",
            worldX: b.worldX,
            worldY: b.worldY,
            radius: 140,
            life: b.life,
            maxLife: 50
          });
        } else if (b.type === "lava_explosion") {
          visualEffects.push({
            type: "lava_explosion",
            worldX: b.worldX,
            worldY: b.worldY,
            radius: 15,
            maxRadius: 200,
            life: b.life,
            maxLife: 35
          });
        } else {
          if (!bullets.some(item => item.id === b.id)) {
            bullets.push({
              id: b.id,
              shooter: b.shooter,
              type: b.type,
              worldX: b.worldX,
              worldY: b.worldY,
              vx: b.vx,
              vy: b.vy,
              radius: b.radius,
              life: b.life,
              damage: b.damage,
              angle: b.angle,
              animFrame: 0
            });
          }
        }
      }
    });

    const cleanupPlayerState = () => {
      remove(ref(db, `players/${currentUser}`));
    };

    // Initialize fishes
    for (let i = 0; i < 30; i++) {
      fishes.push({
        worldX: (Math.random() - 0.5) * 4000,
        worldY: (Math.random() - 0.5) * 4000,
        angle: Math.random() * Math.PI * 2,
        speed: 0.5 + Math.random() * 1,
        timeOffset: Math.random() * 100
      });
    }

    // Camera details
    let screenCenterX = canvas.width / 2;
    let screenCenterY = canvas.height / 2;
    let camShakeTime = 0;
    let camShakeIntensity = 0;

    const triggerCameraShake = (time: number, intensity: number) => {
      camShakeTime = time;
      camShakeIntensity = intensity;
    };

    // Keyboard navigation inputs
    const keys: Record<string, boolean> = { w: false, a: false, s: false, d: false };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT") return;
      const key = e.key.toLowerCase();
      if (key in keys) keys[key] = true;
      if (key === "m") {
        setIsFullScreenMinimap(prev => !prev);
      }
      if (key === "r") {
        toggleRunningRef.current?.();
      }
      if (e.key === " " || key === "spacebar") {
        e.preventDefault();
        castSpecialSpell(selectedSpellRef.current);
      }
      if (e.key === "Shift") {
        e.preventDefault();
        triggerDash();
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key in keys) keys[key] = false;
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    // Mouse and touch tracing
    const mouse = { x: screenCenterX, y: screenCenterY };
    let isMousing = false;
    let isMouseDown = false;

    // Touch controls helpers
    const joystick = {
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      active: false,
      pointerId: null as number | null,
      maxRadius: 60
    };
    const touchAim = { x: screenCenterX, y: screenCenterY, active: false, pointerId: null as number | null };

    // Player Object
    const initialHp = charClass === "wojownik" ? 140 : charClass === "lucznik" ? 105 : 75;
    const initialMana = charClass === "mag" ? 160 : charClass === "lucznik" ? 100 : 70;
    const initialStamina = charClass === "lucznik" ? 140 : charClass === "mag" ? 110 : 80;
    
    // Attributes
    const initialStrength = charClass === "wojownik" ? 14 : charClass === "lucznik" ? 8 : 4;
    const initialEnergy = charClass === "mag" ? 16 : charClass === "lucznik" ? 10 : 6;
    const initialLife = charClass === "wojownik" ? 14 : charClass === "lucznik" ? 10 : 7;
    const initialStaminaAttr = charClass === "lucznik" ? 14 : charClass === "mag" ? 11 : 8;

    const initialSpeed = 5.5;
    const player: PlayerState = {
      worldX: mapSettingsRef.current.width * 32, // Start in center of custom width
      worldY: mapSettingsRef.current.height * 32, // Start in center of custom height
      radius: 18,
      vx: 0,
      vy: 0,
      acceleration: 0.8,
      friction: 0.85,
      maxSpeed: initialSpeed,
      angle: 0,
      hp: initialHp,
      maxHp: initialHp,
      mana: initialMana,
      maxMana: initialMana,
      manaRegen: charClass === "mag" ? 0.44 : charClass === "lucznik" ? 0.32 : 0.22,
      level: 1,
      xp: 0,
      xpNeeded: 100,
      bulletDamage: charClass === "wojownik" ? 52 : charClass === "mag" ? 36 : 28,
      skillPoints: 0,
      statPoints: 0,
      charClass,
      attackCooldown: 0,
      swingSide: 1,
      // Custom new fields
      strength: initialStrength,
      energy: initialEnergy,
      life: initialLife,
      stamina: initialStaminaAttr,
      maxStamina: initialStamina,
      currentStamina: initialStamina,
      isRunning: false
    };

    // Update state to React HUD initially
    setPlayerHp(player.hp);
    setPlayerMaxHp(player.maxHp);
    setPlayerMana(player.mana);
    setPlayerMaxMana(player.maxMana);
    setPlayerLvl(player.level);
    setPlayerXp(player.xp);
    setPlayerXpNeeded(player.xpNeeded);
    
    // Sync initial attribute states to React views
    setPlayerStamina(player.currentStamina);
    setPlayerMaxStamina(player.maxStamina);
    setIsRunning(player.isRunning);
    setStatPoints(player.statPoints);
    setStatStrength(player.strength);
    setStatEnergy(player.energy);
    setStatLife(player.life);
    setStatStaminaStat(player.stamina);

    // Active spell & dash implementation
    const triggerDash = () => {
      if (dashCooldown > 0 || dashActiveTimer > 0) return;

      let dx = 0;
      let dy = 0;

      if (joystick.active) {
        const jdx = joystick.currentX - joystick.startX;
        const jdy = joystick.currentY - joystick.startY;
        const dist = Math.sqrt(jdx * jdx + jdy * jdy);
        if (dist > 0) {
          dx = jdx / dist;
          dy = jdy / dist;
        }
      } else {
        if (keys.w) dy -= 1;
        if (keys.s) dy += 1;
        if (keys.a) dx -= 1;
        if (keys.d) dx += 1;
      }

      if (dx === 0 && dy === 0) {
        dx = Math.cos(player.angle);
        dy = Math.sin(player.angle);
      } else {
        const len = Math.sqrt(dx * dx + dy * dy);
        dx /= len;
        dy /= len;
      }

      dashActiveTimer = 10;
      dashDirectionX = dx;
      dashDirectionY = dy;
      dashCooldown = 75; // 1.25s cooldown

      // Spawn starter circle effect matching player class palette
      visualEffects.push({
        type: player.charClass === "mag" ? "frost_nova" : player.charClass === "wojownik" ? "ground_slam" : "arrow_gale",
        worldX: player.worldX,
        worldY: player.worldY,
        radius: 6,
        maxRadius: 40,
        life: 10,
        maxLife: 10
      });
    };

    const castSpecialSpell = (spellId: 1 | 2 | 3) => {
      if (document.activeElement?.tagName === "INPUT") return;

      if (spellId === 1) {
        if (player.level < 5) return;
        if (skill1Cooldown > 0) return;

        if (player.charClass === "mag") {
          if (player.mana >= 40) {
            player.mana -= 40;
            skill1Cooldown = 240; // 4s cooldown

            visualEffects.push({
              type: "frost_nova",
              worldX: player.worldX,
              worldY: player.worldY,
              radius: 10,
              maxRadius: 130,
              life: 25,
              maxLife: 25
            });

            const bId = `fn_${currentUser}_${Date.now()}`;
            set(ref(db, `bullets/active/${bId}`), {
              id: bId,
              shooter: currentUser,
              type: "frost_nova",
              worldX: player.worldX,
              worldY: player.worldY,
              life: 25
            });

            // Frost Nova Area Damage and Freeze/Slow to monsters
            const dmgRadius = 130;
            const dmg = Math.floor(player.bulletDamage * 1.6) + Math.floor(player.energy * 2.8);
            for (let i = enemies.length - 1; i >= 0; i--) {
              const e = enemies[i];
              const edx = e.worldX - player.worldX;
              const edy = e.worldY - player.worldY;
              const dist = Math.sqrt(edx * edx + edy * edy);
              if (dist < e.radius + dmgRadius) {
                e.hp = Math.max(0, e.hp - dmg);
                const originalSpeed = e.speed;
                e.speed = originalSpeed * 0.44; // Freeze slows down
                setTimeout(() => {
                  if (e) e.speed = originalSpeed;
                }, 2500);

                if (e.id) {
                  set(ref(db, `monsters/${e.id}/hp`), e.hp);
                }
                if (e.state !== "aggressive") {
                  e.state = "aggressive";
                  e.alertProgress = 100;
                }
                alertNearbyEnemies(e);

                if (e.hp <= 0) {
                  if (e.type === "boss") setBossUiActive(false);
                  enemies.splice(i, 1);
                  if (e.id) {
                    remove(ref(db, `monsters/${e.id}`));
                    const lootId = `loot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                    set(ref(db, `loots/${lootId}`), { id: lootId, worldX: e.worldX, worldY: e.worldY, pulse: 0 });
                  }
                  handleGainScore(e.xpReward);
                }
              }
            }
          }
        } else if (player.charClass === "wojownik") {
          if (player.mana >= 35) {
            player.mana -= 35;
            skill1Cooldown = 300; // 5s cooldown

            visualEffects.push({
              type: "ground_slam",
              worldX: player.worldX,
              worldY: player.worldY,
              radius: 10,
              maxRadius: 125,
              life: 25,
              maxLife: 25
            });

            const bId = `gs_${currentUser}_${Date.now()}`;
            set(ref(db, `bullets/active/${bId}`), {
              id: bId,
              shooter: currentUser,
              type: "ground_slam",
              worldX: player.worldX,
              worldY: player.worldY,
              life: 25
            });

            triggerCameraShake(15, 6);

            const dmgRadius = 125;
            const dmg = Math.floor(player.bulletDamage * 1.85) + Math.floor(player.strength * 2.5);
            for (let i = enemies.length - 1; i >= 0; i--) {
              const e = enemies[i];
              const edx = e.worldX - player.worldX;
              const edy = e.worldY - player.worldY;
              const dist = Math.sqrt(edx * edx + edy * edy);
              if (dist < e.radius + dmgRadius) {
                e.hp = Math.max(0, e.hp - dmg);
                if (dist > 0) {
                  e.worldX += (edx / dist) * 36;
                  e.worldY += (edy / dist) * 36;
                }
                if (e.id) {
                  set(ref(db, `monsters/${e.id}/hp`), e.hp);
                }
                if (e.state !== "aggressive") {
                  e.state = "aggressive";
                  e.alertProgress = 100;
                }
                alertNearbyEnemies(e);

                if (e.hp <= 0) {
                  if (e.type === "boss") setBossUiActive(false);
                  enemies.splice(i, 1);
                  if (e.id) {
                    remove(ref(db, `monsters/${e.id}`));
                    const lootId = `loot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                    set(ref(db, `loots/${lootId}`), { id: lootId, worldX: e.worldX, worldY: e.worldY, pulse: 0 });
                  }
                  handleGainScore(e.xpReward);
                }
              }
            }
          }
        } else if (player.charClass === "lucznik") {
          if (player.mana >= 25) {
            player.mana -= 25;
            skill1Cooldown = 180; // 3s cooldown

            const bulletId = `b_${currentUser}_${Date.now()}_s1`;
            const bPayload = {
              id: bulletId,
              shooter: currentUser,
              type: "poison_arrow",
              worldX: player.worldX,
              worldY: player.worldY,
              vx: Math.cos(player.angle) * 17.5,
              vy: Math.sin(player.angle) * 17.5,
              radius: 6,
              life: 75,
              damage: Math.floor(player.bulletDamage * 1.9) + Math.floor(player.strength * 1.5 + player.stamina * 1.0),
              angle: player.angle
            };
            bullets.push(bPayload);
            set(ref(db, `bullets/active/${bulletId}`), bPayload);
          }
        }
      } else if (spellId === 2) {
        if (player.level < 10) return;
        if (skill2Cooldown > 0) return;

        if (player.charClass === "mag") {
          if (player.mana >= 65) {
            player.mana -= 65;
            skill2Cooldown = 480; // 8s cooldown

            for (let i = 0; i < 8; i++) {
              const ang = (Math.PI / 4) * i;
              const bulletId = `b_${currentUser}_${Date.now()}_s2_${i}`;
              const bPayload = {
                id: bulletId,
                shooter: currentUser,
                type: "energy_ball",
                worldX: player.worldX,
                worldY: player.worldY,
                vx: Math.cos(ang) * 9.5,
                vy: Math.sin(ang) * 9.5,
                radius: 11,
                life: 70,
                damage: Math.floor(player.bulletDamage * 1.8) + Math.floor(player.energy * 2.2),
                animFrame: 0
              };
              bullets.push(bPayload);
              set(ref(db, `bullets/active/${bulletId}`), bPayload);
            }
          }
        } else if (player.charClass === "wojownik") {
          if (player.mana >= 55) {
            player.mana -= 55;
            skill2Cooldown = 480; // 8s cooldown

            visualEffects.push({
              type: "blade_whirl",
              worldX: player.worldX,
              worldY: player.worldY,
              radius: 140,
              life: 50,
              maxLife: 50
            });

            const bId = `bw_${currentUser}_${Date.now()}`;
            set(ref(db, `bullets/active/${bId}`), {
              id: bId,
              shooter: currentUser,
              type: "blade_whirl",
              worldX: player.worldX,
              worldY: player.worldY,
              life: 50
            });

            const dmgRadius = 140;
            const dmg = Math.floor(player.bulletDamage * 2.2) + Math.floor(player.strength * 3.0);
            for (let i = enemies.length - 1; i >= 0; i--) {
              const e = enemies[i];
              const edx = e.worldX - player.worldX;
              const edy = e.worldY - player.worldY;
              if (Math.sqrt(edx * edx + edy * edy) < e.radius + dmgRadius) {
                e.hp = Math.max(0, e.hp - dmg);
                if (e.id) {
                  set(ref(db, `monsters/${e.id}/hp`), e.hp);
                }
                if (e.state !== "aggressive") {
                  e.state = "aggressive";
                  e.alertProgress = 100;
                }
                alertNearbyEnemies(e);

                if (e.hp <= 0) {
                  if (e.type === "boss") setBossUiActive(false);
                  enemies.splice(i, 1);
                  if (e.id) {
                    remove(ref(db, `monsters/${e.id}`));
                    const lootId = `loot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                    set(ref(db, `loots/${lootId}`), { id: lootId, worldX: e.worldX, worldY: e.worldY, pulse: 0 });
                  }
                  handleGainScore(e.xpReward);
                }
              }
            }
          }
        } else if (player.charClass === "lucznik") {
          if (player.mana >= 45) {
            player.mana -= 45;
            skill2Cooldown = 360; // 6s cooldown

            for (let i = -3; i <= 3; i++) {
              const spreadAngle = player.angle + i * 0.14;
              const bulletId = `b_${currentUser}_${Date.now()}_s2_${i}`;
              const bPayload = {
                id: bulletId,
                shooter: currentUser,
                type: "arrow",
                worldX: player.worldX,
                worldY: player.worldY,
                vx: Math.cos(spreadAngle) * 15.5,
                vy: Math.sin(spreadAngle) * 15.5,
                radius: 4,
                life: 65,
                damage: Math.floor(player.bulletDamage * 1.15) + Math.floor(player.strength * 0.8),
                angle: spreadAngle
              };
              bullets.push(bPayload);
              set(ref(db, `bullets/active/${bulletId}`), bPayload);
            }
          }
        }
      } else if (spellId === 3) {
        if (player.level < 15) return;
        if (skill3Cooldown > 0) return;

        if (player.charClass === "mag") {
          if (player.mana >= 100) {
            player.mana -= 100;
            skill3Cooldown = 720; // 12s cooldown

            const bulletId = `b_${currentUser}_${Date.now()}_s3`;
            const bPayload = {
              id: bulletId,
              shooter: currentUser,
              type: "arcane_beam",
              worldX: player.worldX,
              worldY: player.worldY,
              vx: Math.cos(player.angle) * 13.5,
              vy: Math.sin(player.angle) * 13.5,
              radius: 25,
              life: 80,
              damage: Math.floor(player.bulletDamage * 4.5) + Math.floor(player.energy * 6.5),
              angle: player.angle
            };
            bullets.push(bPayload);
            set(ref(db, `bullets/active/${bulletId}`), bPayload);
            triggerCameraShake(20, 8);
          }
        } else if (player.charClass === "wojownik") {
          if (player.mana >= 80) {
            player.mana -= 80;
            skill3Cooldown = 840; // 14s cooldown

            const targetDist = 250;
            const newX = player.worldX + Math.cos(player.angle) * targetDist;
            const newY = player.worldY + Math.sin(player.angle) * targetDist;
            player.worldX = Math.max(16, Math.min(mapSettingsRef.current.width * TILE_SIZE - 16, newX));
            player.worldY = Math.max(16, Math.min(mapSettingsRef.current.height * TILE_SIZE - 16, newY));

            visualEffects.push({
              type: "lava_explosion",
              worldX: player.worldX,
              worldY: player.worldY,
              radius: 15,
              maxRadius: 200,
              life: 35,
              maxLife: 35
            });

            const bId = `dl_${currentUser}_${Date.now()}`;
            set(ref(db, `bullets/active/${bId}`), {
              id: bId,
              shooter: currentUser,
              type: "lava_explosion",
              worldX: player.worldX,
              worldY: player.worldY,
              life: 35
            });

            const dmgRadius = 200;
            const dmg = Math.floor(player.bulletDamage * 4.8) + Math.floor(player.strength * 6.8);
            for (let i = enemies.length - 1; i >= 0; i--) {
              const e = enemies[i];
              const edx = e.worldX - player.worldX;
              const edy = e.worldY - player.worldY;
              if (Math.sqrt(edx * edx + edy * edy) < e.radius + dmgRadius) {
                e.hp = Math.max(0, e.hp - dmg);
                if (e.id) {
                  set(ref(db, `monsters/${e.id}/hp`), e.hp);
                }
                if (e.state !== "aggressive") {
                  e.state = "aggressive";
                  e.alertProgress = 100;
                }
                alertNearbyEnemies(e);

                if (e.hp <= 0) {
                  if (e.type === "boss") setBossUiActive(false);
                  enemies.splice(i, 1);
                  if (e.id) {
                    remove(ref(db, `monsters/${e.id}`));
                    const lootId = `loot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                    set(ref(db, `loots/${lootId}`), { id: lootId, worldX: e.worldX, worldY: e.worldY, pulse: 0 });
                  }
                  handleGainScore(e.xpReward);
                }
              }
            }
            triggerCameraShake(35, 12);
          }
        } else if (player.charClass === "lucznik") {
          if (player.mana >= 75) {
            player.mana -= 75;
            skill3Cooldown = 900; // 15s cooldown

            windriderActiveTimer = 240;

            const bulletId = `b_${currentUser}_${Date.now()}_s3`;
            const bPayload = {
              id: bulletId,
              shooter: currentUser,
              type: "hurricane_arrow",
              worldX: player.worldX,
              worldY: player.worldY,
              vx: Math.cos(player.angle) * 19,
              vy: Math.sin(player.angle) * 19,
              radius: 17,
              life: 75,
              damage: Math.floor(player.bulletDamage * 4.2) + Math.floor(player.strength * 3.5 + player.stamina * 2.5),
              angle: player.angle
            };
            bullets.push(bPayload);
            set(ref(db, `bullets/active/${bulletId}`), bPayload);

            visualEffects.push({
              type: "arrow_gale",
              worldX: player.worldX,
              worldY: player.worldY,
              life: 60,
              maxLife: 60
            });
          }
        }
      }

      setPlayerMana(player.mana);
    };

    castSpellRef.current = (spellId: 1 | 2 | 3) => {
      castSpecialSpell(spellId);
    };
    triggerDashRef.current = () => {
      triggerDash();
    };
    toggleRunningRef.current = () => {
      player.isRunning = !player.isRunning;
      setIsRunning(player.isRunning);
      
      visualEffects.push({
        type: "damage_flash",
        worldX: player.worldX,
        worldY: player.worldY,
        life: 25,
        maxLife: 25,
        text: player.isRunning ? "AUTORUN: WŁĄCZONY" : "AUTORUN: WYŁĄCZONY",
        color: player.isRunning ? "#f1c40f" : "#95a5a6"
      });
    };
    allocateStatRef.current = (statName: "strength" | "energy" | "life" | "stamina" | "speed") => {
      if (player.statPoints <= 0) return;
      player.statPoints -= 1;
      setStatPoints(player.statPoints);
      
      if (statName === "strength") {
        player.strength += 1;
        setStatStrength(player.strength);
        player.bulletDamage += 1;
        visualEffects.push({
          type: "damage_flash",
          worldX: player.worldX,
          worldY: player.worldY,
          life: 30,
          maxLife: 30,
          text: "+1 SIŁA (Zwiększono DMG!)",
          color: "#e74c3c"
        });
      } else if (statName === "energy") {
        player.energy += 1;
        setStatEnergy(player.energy);
        player.maxMana = player.maxMana + 8;
        player.mana = Math.min(player.maxMana, player.mana + 15);
        player.manaRegen += 0.02;
        setPlayerMaxMana(player.maxMana);
        setPlayerMana(player.mana);
        visualEffects.push({
          type: "damage_flash",
          worldX: player.worldX,
          worldY: player.worldY,
          life: 30,
          maxLife: 30,
          text: "+1 ENERGIA (Większa MANA!)",
          color: "#3498db"
        });
      } else if (statName === "life") {
        player.life += 1;
        setStatLife(player.life);
        player.maxHp = player.maxHp + 10;
        player.hp = Math.min(player.maxHp, player.hp + 20);
        setPlayerMaxHp(player.maxHp);
        setPlayerHp(player.hp);
        visualEffects.push({
          type: "damage_flash",
          worldX: player.worldX,
          worldY: player.worldY,
          life: 30,
          maxLife: 30,
          text: "+1 ŻYCIE (Więcej HP!)",
          color: "#2ecc71"
        });
      } else if (statName === "stamina") {
        player.stamina += 1;
        setStatStaminaStat(player.stamina);
        player.maxStamina = 100 + player.stamina * 20;
        player.currentStamina = Math.min(player.maxStamina, player.currentStamina + 20);
        setPlayerMaxStamina(player.maxStamina);
        setPlayerStamina(player.currentStamina);
        visualEffects.push({
          type: "damage_flash",
          worldX: player.worldX,
          worldY: player.worldY,
          life: 30,
          maxLife: 30,
          text: "+1 KONDYCJA (+20 Stamina / +5% do Regen!)",
          color: "#f39c12"
        });
      } else if (statName === "speed") {
        player.speed = (player.speed || 0) + 1;
        setStatSpeed(player.speed);
        visualEffects.push({
          type: "damage_flash",
          worldX: player.worldX,
          worldY: player.worldY,
          life: 30,
          maxLife: 30,
          text: "+1 SZYBKOŚĆ (+5% Prędkości Chodu!)",
          color: "#9b59b6"
        });
      }
      set(ref(db, `players/${currentUser}/level`), player.level);
      set(ref(db, `players/${currentUser}/maxHp`), player.maxHp);
    };

    // Alert nearby enemies helper
    const alertNearbyEnemies = (sourceEnemy: any, range = 350) => {
      enemies.forEach((e) => {
        if (e.state !== "aggressive") {
          const dx = e.worldX - sourceEnemy.worldX;
          const bgDam = e.worldY - sourceEnemy.worldY;
          if (Math.sqrt(dx * dx + bgDam * bgDam) < range) {
            e.state = "aggressive";
            e.alertProgress = 100;
          }
        }
      });
    };

    // Hero offensive attacks
    const triggerPlayerAttack = () => {
      if (player.attackCooldown > 0) return;

      if (player.charClass === "mag") {
        if (player.mana >= 15) {
          player.mana -= 15;
          const bulletId = `b_${currentUser}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
          const bPayload = {
            id: bulletId,
            shooter: currentUser,
            type: "energy_ball",
            worldX: player.worldX,
            worldY: player.worldY,
            vx: Math.cos(player.angle) * 11,
            vy: Math.sin(player.angle) * 11,
            radius: 8,
            life: 65,
            damage: player.bulletDamage + Math.floor(player.energy * 1.2),
            animFrame: 0
          };
          bullets.push(bPayload);
          set(ref(db, `bullets/active/${bulletId}`), bPayload);
          player.attackCooldown = 18;
        }
      } else if (player.charClass === "wojownik") {
        if (player.mana >= 12) {
          player.mana -= 12;
          player.swingSide *= -1;

          const attackAngle = player.angle + 0.45 * player.swingSide;
          visualEffects.push({
            type: "slash",
            worldX: player.worldX,
            worldY: player.worldY,
            angle: attackAngle,
            side: player.swingSide,
            life: 12,
            maxLife: 12
          });

          // Sync warrior slash visually to others
          const slashId = `slash_${currentUser}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
          const sPayload = {
            id: slashId,
            shooter: currentUser,
            type: "slash",
            worldX: player.worldX,
            worldY: player.worldY,
            vx: 0,
            vy: 0,
            radius: 45,
            life: 12,
            maxLife: 12,
            angle: attackAngle,
            side: player.swingSide
          };
          set(ref(db, `bullets/active/${slashId}`), sPayload);

          const range = 85;
          const ax = player.worldX + Math.cos(player.angle) * 40;
          const ay = player.worldY + Math.sin(player.angle) * 40;

          // Hit enemies
          for (let i = enemies.length - 1; i >= 0; i--) {
            const e = enemies[i];
            const edx = e.worldX - ax;
            const edy = e.worldY - ay;
            if (Math.sqrt(edx * edx + edy * edy) < e.radius + range / 2) {
              const finalSlashDmg = player.bulletDamage + Math.floor(player.strength * 1.5);
              e.hp = Math.max(0, e.hp - finalSlashDmg);
              if (e.id) {
                set(ref(db, `monsters/${e.id}/hp`), e.hp);
              }

              if (e.state !== "aggressive") {
                e.state = "aggressive";
                e.alertProgress = 100;
                if (e.id) {
                  set(ref(db, `monsters/${e.id}/state`), "aggressive");
                  set(ref(db, `monsters/${e.id}/alertProgress`), 100);
                }
              }
              alertNearbyEnemies(e);
              triggerCameraShake(8, 3.5);

              if (e.hp <= 0) {
                if (e.type === "boss") setBossUiActive(false);
                enemies.splice(i, 1);
                if (e.id) {
                  remove(ref(db, `monsters/${e.id}`));
                  const lootId = `loot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                  set(ref(db, `loots/${lootId}`), {
                    id: lootId,
                    worldX: e.worldX,
                    worldY: e.worldY,
                    pulse: 0
                  });
                }
                handleGainScore(e.xpReward);
              }
            }
          }

          // Hit animals
          animals.forEach((a, aIdx) => {
            const adx = a.worldX - ax;
            const ady = a.worldY - ay;
            if (Math.sqrt(adx * adx + ady * ady) < a.radius + range / 2) {
              const finalSlashDmg = player.bulletDamage + Math.floor(player.strength * 1.5);
              a.hp -= finalSlashDmg;
              if (a.id) {
                set(ref(db, `animals/${a.id}/hp`), a.hp);
              }
              if (a.hp <= 0) {
                if (a.id) {
                  remove(ref(db, `animals/${a.id}`));
                  const lootId = `loot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                  set(ref(db, `loots/${lootId}`), {
                    id: lootId,
                    worldX: a.worldX,
                    worldY: a.worldY,
                    pulse: 0
                  });
                } else {
                  loots.push({ worldX: a.worldX, worldY: a.worldY, pulse: 0 });
                }
                animals.splice(aIdx, 1);
              }
            }
          });

          player.attackCooldown = 8;
        }
      } else if (player.charClass === "lucznik") {
        if (player.mana >= 7) {
          player.mana -= 7;
          const spread = (Math.random() - 0.5) * 0.06;
          const finalAngle = player.angle + spread;

          const bulletId = `b_${currentUser}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
          const bPayload = {
            id: bulletId,
            shooter: currentUser,
            type: "arrow",
            worldX: player.worldX,
            worldY: player.worldY,
            vx: Math.cos(finalAngle) * 15,
            vy: Math.sin(finalAngle) * 15,
            radius: 4,
            life: 65,
            damage: player.bulletDamage + Math.floor(player.strength * 1.0),
            angle: finalAngle
          };
          bullets.push(bPayload);
          set(ref(db, `bullets/active/${bulletId}`), bPayload);
          player.attackCooldown = 9;
        }
      }

      // Sync React indicators
      setPlayerMana(player.mana);
    };

    // Gain score / Level Up calculations including Admin Leveling multiplier!
    const handleGainScore = (xpEarned: number) => {
      const addedScore = score + 1;
      setScore(addedScore);
      statsRef.current.score = addedScore;

      // Apply Gaining Level speed scaler from configuration settings directly!
      const finalXpEarned = Math.floor(xpEarned * mapSettingsRef.current.xpRateMultiplier);
      player.xp += finalXpEarned;

      if (player.xp >= player.xpNeeded) {
        player.xp -= player.xpNeeded;
        player.level += 1;
        player.skillPoints += 3;
        player.statPoints += 4;
        player.xpNeeded = Math.floor(player.xpNeeded * 1.55);

        // Max out stats and stamina on level up
        player.maxHp = Math.floor(player.maxHp * 1.05);
        player.hp = player.maxHp;
        player.maxMana = Math.floor(player.maxMana * 1.05);
        player.mana = player.maxMana;
        player.currentStamina = player.maxStamina;
        player.bulletDamage = Math.floor(player.bulletDamage * 1.04);

        setStatPoints(player.statPoints);
        setPlayerMaxHp(player.maxHp);
        setPlayerMaxMana(player.maxMana);
        setPlayerStamina(player.currentStamina);
        setPlayerLvl(player.level);
        setPlayerXpNeeded(player.xpNeeded);
      }

      setPlayerXp(player.xp);
      setPlayerHp(player.hp);
      setPlayerMana(player.mana);

      onGameStatsUpdated(player.level, addedScore);
    };

    // Dynamic environmental physics
    let gameTime = 1200;
    let weatherTimer = 3000;
    const WEATHER_PRESETS = ["sunny", "rain", "snow", "fog", "thunder"];
    let thunderFlash = 0;

    const runWeatherCycle = () => {
      gameTime = (gameTime + 0.35) % 2400;
      weatherTimer--;

      if (weatherTimer <= 0) {
        const nextWeather = WEATHER_PRESETS[Math.floor(Math.random() * WEATHER_PRESETS.length)];
        setCurrentWeather(nextWeather);
        weatherTimer = 2500 + Math.random() * 2500;
      }

      // Fallback rain/particles generator
      if ((currentWeather === "rain" || currentWeather === "thunder") && particles.length < 150) {
        particles.push({
          x: Math.random() * canvas.width,
          y: -15,
          speed: 10 + Math.random() * 5,
          len: 15 + Math.random() * 8,
          type: "rain"
        });
      } else if (currentWeather === "snow" && particles.length < 90) {
        particles.push({
          x: Math.random() * canvas.width,
          y: -15,
          speed: 2.2 + Math.random() * 2,
          drift: (Math.random() - 0.5) * 1,
          len: 3 + Math.random() * 3,
          type: "snow"
        });
      }

      if (currentWeather === "thunder" && Math.random() < 0.0035 && thunderFlash <= 0) {
        thunderFlash = 9;
        triggerCameraShake(18, 6.5);
      }

      if (thunderFlash > 0) thunderFlash--;

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        if (p.type === "rain") {
          p.y += p.speed;
          p.x += 1;
        } else {
          p.y += p.speed;
          p.x += p.drift;
        }
        if (p.y > canvas.height) particles.splice(i, 1);
      }
    };

    // Helper: Paint edited biome or add spawn point
    const handleMouseInteraction = (clientX: number, clientY: number) => {
      if (!isAdminActive || editorTool === "none") return;

      const scaleX = canvas.width / canvas.clientWidth;
      const scaleY = canvas.height / canvas.clientHeight;
      const canvasMouseX = clientX * scaleX;
      const canvasMouseY = clientY * scaleY;

      // Translate canvas coordinate inside world coordinate system using camera offsets
      const cameraX = player.worldX - screenCenterX;
      const cameraY = player.worldY - screenCenterY;
      const worldClickX = canvasMouseX + cameraX;
      const worldClickY = canvasMouseY + cameraY;

      // Map coordinate to tile format
      const tx = Math.floor(worldClickX / TILE_SIZE);
      const ty = Math.floor(worldClickY / TILE_SIZE);

      if (tx < 0 || tx >= mapSettingsRef.current.width || ty < 0 || ty >= mapSettingsRef.current.height) {
        return;
      }

      if (editorTool === "paint") {
        const key = `${tx},${ty}`;
        onMapTileCustomized(key, selectedBiome);
      } else if (editorTool === "add_spawn") {
        const newId = `spawn_dyn_${Date.now()}`;
        const newSpawn: SpawnPoint = {
          id: newId,
          x: tx,
          y: ty,
          monsterType: selectedSpawnType // Uses the admin selected type!
        };
        onSpawnPointAdded(newSpawn);
      }
    };

    let lastMouseDownTime = 0;
    let lastJoystickTapTime = 0;

    // Mouse events config
    const onMouseDown = (e: MouseEvent) => {
      if (document.activeElement?.tagName === "INPUT") return;
      if (e.button === 0) {
        const rect = canvas.getBoundingClientRect();
        const canvasX = e.clientX - rect.left;
        const canvasY = e.clientY - rect.top;

        if (isFullScreenMinimapRef.current) {
          setIsFullScreenMinimap(false);
          return;
        }

        const miniRadius = 65;
        const miniCenterX = canvas.width - miniRadius - 20;
        const miniCenterY = canvas.height - miniRadius - 20;
        const distSq = (canvasX - miniCenterX) * (canvasX - miniCenterX) + (canvasY - miniCenterY) * (canvasY - miniCenterY);
        if (distSq < miniRadius * miniRadius) {
          setIsFullScreenMinimap(true);
          return;
        }

        const now = Date.now();
        if (now - lastMouseDownTime < 240) {
          triggerDash();
          lastMouseDownTime = now;
          return;
        }
        lastMouseDownTime = now;

        isMouseDown = true;
        if (isAdminActive && editorTool !== "none") {
          handleMouseInteraction(e.clientX, e.clientY);
        } else if (player.charClass !== "lucznik") {
          triggerPlayerAttack();
        }
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) isMouseDown = false;
    };

    const onMouseMove = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      isMousing = true;

      // Paint continuously on hold if in paint mode
      if (isMouseDown && isAdminActive && editorTool === "paint") {
        handleMouseInteraction(e.clientX, e.clientY);
      }
    };

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mousemove", onMouseMove);

    // Touch Pointer Events
    const onPointerDown = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      if (isFullScreenMinimapRef.current) {
        setIsFullScreenMinimap(false);
        return;
      }

      const miniRadius = 65;
      const miniCenterX = canvas.width - miniRadius - 20;
      const miniCenterY = canvas.height - miniRadius - 20;
      const distSq = (canvasX - miniCenterX) * (canvasX - miniCenterX) + (canvasY - miniCenterY) * (canvasY - miniCenterY);
      if (distSq < miniRadius * miniRadius) {
        setIsFullScreenMinimap(true);
        return;
      }

      if (e.clientX < canvas.width / 2) {
        const now = Date.now();
        if (now - lastJoystickTapTime < 240 && !joystick.active) {
          triggerDash();
          lastJoystickTapTime = now;
          return;
        }
        lastJoystickTapTime = now;

        if (!joystick.active) {
          joystick.active = true;
          joystick.pointerId = e.pointerId;
          joystick.startX = joystick.currentX = e.clientX;
          joystick.startY = joystick.currentY = e.clientY;
        }
      } else if (e.clientX >= canvas.width / 2) {
        touchAim.active = true;
        touchAim.pointerId = e.pointerId;
        touchAim.x = e.clientX;
        touchAim.y = e.clientY;
        isMousing = false;
        isMouseDown = true;

        if (isAdminActive && editorTool !== "none") {
          handleMouseInteraction(e.clientX, e.clientY);
        } else if (player.charClass !== "lucznik") {
          triggerPlayerAttack();
        }
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (joystick.active && e.pointerId === joystick.pointerId) {
        joystick.currentX = e.clientX;
        joystick.currentY = e.clientY;
      }
      if (touchAim.active && e.pointerId === touchAim.pointerId) {
        touchAim.x = e.clientX;
        touchAim.y = e.clientY;
        isMousing = false;

        if (isAdminActive && editorTool === "paint" && isMouseDown) {
          handleMouseInteraction(e.clientX, e.clientY);
        }
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (joystick.active && e.pointerId === joystick.pointerId) joystick.active = false;
      if (touchAim.active && e.pointerId === touchAim.pointerId) {
        touchAim.active = false;
        isMouseDown = false;
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);

    // Real-time loop calculations
    const updateGameElements = () => {
      runWeatherCycle();

      // Decrement skill and dash cooldowns every frame
      if (skill1Cooldown > 0) skill1Cooldown--;
      if (skill2Cooldown > 0) skill2Cooldown--;
      if (skill3Cooldown > 0) skill3Cooldown--;
      if (dashCooldown > 0) dashCooldown--;
      if (windriderActiveTimer > 0) windriderActiveTimer--;

      // Regen resources
      if (player.mana < player.maxMana) {
        // dynamic energy stat scaling mana regeneration rate
        const dynamicManaRegen = player.manaRegen + (player.energy * 0.015);
        player.mana = Math.min(player.maxMana, player.mana + dynamicManaRegen);
        setPlayerMana(player.mana);
      }

      if (player.attackCooldown > 0) player.attackCooldown--;

      // Continuous shooting for Archer
      if (isMouseDown && player.charClass === "lucznik" && player.attackCooldown <= 0 && editorTool === "none") {
        triggerPlayerAttack();
      }

      // Check current tile constraints and apply water speed reduction
      const pTileX = Math.floor(player.worldX / TILE_SIZE);
      const pTileY = Math.floor(player.worldY / TILE_SIZE);
      const customKey = `${pTileX},${pTileY}`;
      
      const currentMapTile =
         mapSettingsRef.current.tiles[customKey] ||
         getNoiseTileAt(pTileX, pTileY, mapSettingsRef.current.width, mapSettingsRef.current.height);

      // Hero speed modifications including custom Admin Multiplier!
      let finalMaxSpeed = player.maxSpeed * mapSettingsRef.current.playerSpeedMultiplier;
      if (windriderActiveTimer > 0) {
        finalMaxSpeed *= 1.85; // extreme speedup under Windrider ultimate!
      }
      const speedModifier = currentMapTile === "WATER" ? 0.52 : 1.0;
      let maxSpeedLimit = finalMaxSpeed * speedModifier;
      
      // Run mode handling
      const isMoving = !!(keys.w || keys.s || keys.a || keys.d || joystick.active);
      if (player.isRunning) {
        if (player.currentStamina > 0 && isMoving) {
          maxSpeedLimit *= 1.5;
          player.currentStamina = Math.max(0, player.currentStamina - 0.4);
          setPlayerStamina(player.currentStamina);
          
          if (player.currentStamina <= 0) {
            player.isRunning = false;
            setIsRunning(false);
            visualEffects.push({
              type: "damage_flash",
              worldX: player.worldX,
              worldY: player.worldY,
              life: 30,
              maxLife: 30,
              text: "ZMĘCZENIE (BRAK STAMINY)",
              color: "#95a5a6"
            });
          }
        } else {
          if (player.currentStamina < player.maxStamina) {
            player.currentStamina = Math.min(player.maxStamina, player.currentStamina + 0.12 + (player.stamina * 0.01));
            setPlayerStamina(player.currentStamina);
          }
        }
      } else {
        if (player.currentStamina < player.maxStamina) {
          player.currentStamina = Math.min(player.maxStamina, player.currentStamina + 0.18 + (player.stamina * 0.015));
          setPlayerStamina(player.currentStamina);
        }
      }

      // Stamina-based HP regeneration during standstill ("podczas postoju")
      if (!isMoving && player.hp < player.maxHp) {
        // każdy jeden punkt dodany do staminy to 0.2 punktów życia na 1 sekunde do regeneracji punktów zdrowia
        const hpRegenPerSec = player.stamina * 0.2;
        const hpRegenPerFrame = hpRegenPerSec / 60;
        player.hp = Math.min(player.maxHp, player.hp + hpRegenPerFrame);
        setPlayerHp(player.hp);
      }

      const acceleration = player.acceleration * speedModifier;

      let ax = 0;
      let ay = 0;

      if (joystick.active) {
        const dx = joystick.currentX - joystick.startX;
        const dy = joystick.currentY - joystick.startY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 0) {
          const angle = Math.atan2(dy, dx);
          const intensity = Math.min(dist, joystick.maxRadius) / joystick.maxRadius;
          ax = Math.cos(angle) * acceleration * intensity;
          ay = Math.sin(angle) * acceleration * intensity;
        }
      } else {
        if (keys.w) ay -= acceleration;
        if (keys.s) ay += acceleration;
        if (keys.a) ax -= acceleration;
        if (keys.d) ax += acceleration;
      }

      player.vx += ax;
      player.vy += ay;
      player.vx *= player.friction;
      player.vy *= player.friction;

      const actSpeed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
      if (actSpeed > maxSpeedLimit) {
        player.vx = (player.vx / actSpeed) * maxSpeedLimit;
        player.vy = (player.vy / actSpeed) * maxSpeedLimit;
      }

      // Border constraints (keep inside the grid dynamically, support Dash movement and invincibility frames)
      if (dashActiveTimer > 0) {
        player.worldX = Math.max(16, Math.min(mapSettingsRef.current.width * TILE_SIZE - 16, player.worldX + dashDirectionX * 22));
        player.worldY = Math.max(16, Math.min(mapSettingsRef.current.height * TILE_SIZE - 16, player.worldY + dashDirectionY * 22));

        if (dashActiveTimer % 2 === 0) {
          visualEffects.push({
            type: "dash_ghost",
            worldX: player.worldX,
            worldY: player.worldY,
            angle: player.angle,
            charClass: player.charClass,
            life: 14,
            maxLife: 14
          });
        }
        dashActiveTimer--;
      } else {
        player.worldX = Math.max(16, Math.min(mapSettingsRef.current.width * TILE_SIZE - 16, player.worldX + player.vx));
        player.worldY = Math.max(16, Math.min(mapSettingsRef.current.height * TILE_SIZE - 16, player.worldY + player.vy));
      }

      // Projectiles target angle
      let targetScreenX = screenCenterX;
      let targetScreenY = screenCenterY;
      if (touchAim.active) {
        targetScreenX = touchAim.x;
        targetScreenY = touchAim.y;
      } else if (isMousing) {
        targetScreenX = mouse.x;
        targetScreenY = mouse.y;
      }

      const diffX = targetScreenX - screenCenterX;
      const diffY = targetScreenY - screenCenterY;
      if (Math.abs(diffX) > 1 || Math.abs(diffY) > 1) {
        player.angle = Math.atan2(diffY, diffX);
      }

      // Update projectiles
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        
        // Mage homing energy ball implementation
        if (b.type === "energy_ball") {
          b.animFrame = (b.animFrame || 0) + 1;
          
          let closestTarget: { x: number; y: number } | null = null;
          let minDistance = 220.0; // range of proximity

          // Find closest monster
          enemies.forEach((e) => {
            const dx = e.worldX - b.worldX;
            const dy = e.worldY - b.worldY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDistance) {
              minDistance = dist;
              closestTarget = { x: e.worldX, y: e.worldY };
            }
          });

          // Find closest peaceful animal / wildlife
          animals.forEach((a) => {
            const dx = a.worldX - b.worldX;
            const dy = a.worldY - b.worldY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDistance) {
              minDistance = dist;
              closestTarget = { x: a.worldX, y: a.worldY };
            }
          });

          // Find closest online competitor
          Object.keys(otherPlayers).forEach((pName) => {
            if (pName !== currentUser) {
              const op = otherPlayers[pName];
              if (op) {
                const dx = op.worldX - b.worldX;
                const dy = op.worldY - b.worldY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < minDistance) {
                  minDistance = dist;
                  closestTarget = { x: op.worldX, y: op.worldY };
                }
              }
            }
          });

          if (closestTarget) {
            const trg: { x: number; y: number } = closestTarget;
            const dx = trg.x - b.worldX;
            const dy = trg.y - b.worldY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 1) {
              const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || 12;
              const targetVx = (dx / dist) * speed;
              const targetVy = (dy / dist) * speed;
              const steer = 0.28;
              b.vx = b.vx * (1 - steer) + targetVx * steer;
              b.vy = b.vy * (1 - steer) + targetVy * steer;
              b.angle = Math.atan2(b.vy, b.vx);
            }
          }
        }

        b.worldX += b.vx;
        b.worldY += b.vy;
        b.life--;

        // PvP collision check: did a bullet shot by another player hit us?
        if (b.shooter && b.shooter !== currentUser && dashActiveTimer <= 0) {
          const dx = player.worldX - b.worldX;
          const dy = player.worldY - b.worldY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < player.radius + b.radius) {
            const finalDmg = Math.ceil(b.damage || 15);
            player.hp = Math.max(0, player.hp - finalDmg);
            setPlayerHp(player.hp);
            triggerCameraShake(12, 4);
            
            visualEffects.push({
              type: "damage_flash",
              worldX: player.worldX,
              worldY: player.worldY,
              life: 20,
              maxLife: 20,
              text: `-${finalDmg}`,
              color: "#ff3333"
            });

            if (player.hp <= 0) {
              alert(`Zostałeś pokonany przez gracza ${b.shooter}!`);
              
              const freshHp = charClass === "wojownik" ? 140 : charClass === "lucznik" ? 105 : 75;
              const freshMana = charClass === "mag" ? 160 : charClass === "lucznik" ? 100 : 70;
              const freshStamina = charClass === "lucznik" ? 140 : charClass === "mag" ? 110 : 80;
              const freshStrengthAttr = charClass === "wojownik" ? 14 : charClass === "mag" ? 4 : 8;
              const freshEnergyAttr = charClass === "mag" ? 16 : charClass === "lucznik" ? 10 : 6;
              const freshLifeAttr = charClass === "wojownik" ? 14 : charClass === "lucznik" ? 10 : 7;
              const freshStaminaAttr = charClass === "lucznik" ? 14 : charClass === "mag" ? 11 : 8;

              player.hp = freshHp;
              player.maxHp = freshHp;
              player.mana = freshMana;
              player.maxMana = freshMana;
              player.currentStamina = freshStamina;
              player.maxStamina = freshStamina;
              player.strength = freshStrengthAttr;
              player.energy = freshEnergyAttr;
              player.life = freshLifeAttr;
              player.stamina = freshStaminaAttr;
              player.level = 1;
              player.xp = 0;
              player.xpNeeded = 100;
              player.skillPoints = 0;
              player.statPoints = 0;
              player.isRunning = false;
              player.bulletDamage = charClass === "wojownik" ? 52 : charClass === "mag" ? 36 : 28;

              setScore(0);
              statsRef.current.score = 0;
              enemies.length = 0;
              bullets.length = 0;
              enemyBullets.length = 0;
              setBossUiActive(false);

              setPlayerHp(player.hp);
              setPlayerMaxHp(player.maxHp);
              setPlayerMana(player.mana);
              setPlayerMaxMana(player.maxMana);
              setPlayerLvl(player.level);
              setPlayerXp(player.xp);
              setPlayerXpNeeded(player.xpNeeded);
              setStatPoints(player.statPoints);
              setStatStrength(player.strength);
              setStatEnergy(player.energy);
              setStatLife(player.life);
              setStatStaminaStat(player.stamina);
              onGameStatsUpdated(1, 0);

              set(ref(db, `players/${currentUser}`), {
                username: currentUser,
                worldX: player.worldX,
                worldY: player.worldY,
                angle: player.angle,
                charClass: player.charClass,
                hp: player.hp,
                maxHp: player.maxHp,
                level: player.level,
                score: statsRef.current.score,
                lastUpdate: Date.now()
              });
            }

            bullets.splice(i, 1);
            if (b.id) {
              remove(ref(db, `bullets/active/${b.id}`));
            }
            continue;
          }
        }

        if (b.life <= 0) {
          bullets.splice(i, 1);
        }
      }

      for (let i = visualEffects.length - 1; i >= 0; i--) {
        visualEffects[i].life--;
        if (visualEffects[i].life <= 0) visualEffects.splice(i, 1);
      }

      // Update monster projectiles
      for (let i = enemyBullets.length - 1; i >= 0; i--) {
        const eb = enemyBullets[i];
        eb.worldX += eb.vx;
        eb.worldY += eb.vy;
        eb.life--;

        const edx = player.worldX - eb.worldX;
        const edy = player.worldY - eb.worldY;
        if (Math.sqrt(edx * edx + edy * edy) < player.radius + eb.radius) {
          // Monster damage includes Admin multiplier strength adjustments!
          const scaledDmg = Math.ceil(12 * mapSettingsRef.current.monsterStrengthMultiplier);
          player.hp = Math.max(0, player.hp - scaledDmg);
          setPlayerHp(player.hp);
          triggerCameraShake(10, 3.5);
          enemyBullets.splice(i, 1);
          continue;
        }

        if (eb.life <= 0) enemyBullets.splice(i, 1);
      }

      // Fishes random moves
      fishes.forEach((f) => {
        f.timeOffset += 0.02;
        f.angle += Math.sin(f.timeOffset) * 0.1;
        f.worldX += Math.cos(f.angle) * f.speed;
        f.worldY += Math.sin(f.angle) * f.speed;

        if (Math.abs(f.worldX - player.worldX) > 1500 || Math.abs(f.worldY - player.worldY) > 1500) {
          f.worldX = player.worldX + (Math.random() - 0.5) * 1500;
          f.worldY = player.worldY + (Math.random() - 0.5) * 1500;
        }
      });

       // Throttle and publish our own player status to Firebase DB for other clients
       syncThrottle++;
       if (syncThrottle >= 6) {
         syncThrottle = 0;
         setSpell1Cooldown(Math.ceil(skill1Cooldown / 60));
         setSpell2Cooldown(Math.ceil(skill2Cooldown / 60));
         setSpell3Cooldown(Math.ceil(skill3Cooldown / 60));
         setDashCooldown(Math.ceil(dashCooldown / 60));

         set(ref(db, `players/${currentUser}`), {
           username: currentUser,
           worldX: player.worldX,
           worldY: player.worldY,
           angle: player.angle,
           charClass: player.charClass,
           hp: player.hp,
           maxHp: player.maxHp,
           level: player.level,
           score: statsRef.current.score,
           lastUpdate: Date.now()
         });
       }

      // Update projectiles
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.worldX += b.vx;
        b.worldY += b.vy;
        b.life--;
        if (b.type === "energy_ball") b.animFrame++;

        if (b.life <= 0) {
          if (b.shooter === currentUser && b.id) {
            remove(ref(db, `bullets/active/${b.id}`));
          }
          bullets.splice(i, 1);
        }
      }

      for (let i = visualEffects.length - 1; i >= 0; i--) {
        visualEffects[i].life--;
        if (visualEffects[i].life <= 0) visualEffects.splice(i, 1);
      }

      // Update monster projectiles
      for (let i = enemyBullets.length - 1; i >= 0; i--) {
        const eb = enemyBullets[i];
        eb.worldX += eb.vx;
        eb.worldY += eb.vy;
        eb.life--;

        const edx = player.worldX - eb.worldX;
        const edy = player.worldY - eb.worldY;
        if (dashActiveTimer <= 0 && Math.sqrt(edx * edx + edy * edy) < player.radius + eb.radius) {
          const scaledDmg = Math.ceil(12 * mapSettingsRef.current.monsterStrengthMultiplier);
          player.hp = Math.max(0, player.hp - scaledDmg);
          setPlayerHp(player.hp);
          triggerCameraShake(10, 3.5);
          enemyBullets.splice(i, 1);
          continue;
        }

        if (eb.life <= 0) enemyBullets.splice(i, 1);
      }

      // Fishes random moves
      fishes.forEach((f) => {
        f.timeOffset += 0.02;
        f.angle += Math.sin(f.timeOffset) * 0.1;
        f.worldX += Math.cos(f.angle) * f.speed;
        f.worldY += Math.sin(f.angle) * f.speed;

        if (Math.abs(f.worldX - player.worldX) > 1500 || Math.abs(f.worldY - player.worldY) > 1500) {
          f.worldX = player.worldX + (Math.random() - 0.5) * 1500;
          f.worldY = player.worldY + (Math.random() - 0.5) * 1500;
        }
      });

      // Loots magnet/pickups
      for (let i = loots.length - 1; i >= 0; i--) {
        const l = loots[i];
        const ldx = player.worldX - l.worldX;
        const ldy = player.worldY - l.worldY;
        const lDist = Math.sqrt(ldx * ldx + ldy * ldy);

        if (lDist < player.radius + 18) {
          player.hp = Math.min(player.maxHp, player.hp + 20);
          setPlayerHp(player.hp);
          if (l.id) {
            remove(ref(db, `loots/${l.id}`));
          } else {
            loots.splice(i, 1);
          }
        }
      }

      // Wildlife mechanics
      if (isHost()) {
        for (let i = animals.length - 1; i >= 0; i--) {
          const a = animals[i];
          const adx = player.worldX - a.worldX;
          const ady = player.worldY - a.worldY;
          const dist = Math.sqrt(adx * adx + ady * ady);

          if (a.behavior === "scared") {
            if (dist < 180) {
              const runAngle = Math.atan2(ady, adx) + Math.PI;
              a.worldX += Math.cos(runAngle) * a.speed;
              a.worldY += Math.sin(runAngle) * a.speed;
            } else {
              a.worldX += (Math.random() - 0.5) * 0.5;
              a.worldY += (Math.random() - 0.5) * 0.5;
            }
          } else if (a.behavior === "aggressive") {
            let targetX = player.worldX;
            let targetY = player.worldY;
            let minDist = dist;

            Object.keys(otherPlayers).forEach((pName) => {
              const op = otherPlayers[pName];
              const d = Math.sqrt((op.worldX - a.worldX)**2 + (op.worldY - a.worldY)**2);
              if (d < minDist) {
                minDist = d;
                targetX = op.worldX;
                targetY = op.worldY;
              }
            });

            if (minDist < a.vision) {
              const approachAngle = Math.atan2(targetY - a.worldY, targetX - a.worldX);
              a.worldX += Math.cos(approachAngle) * a.speed;
              a.worldY += Math.sin(approachAngle) * a.speed;

              if (dashActiveTimer <= 0 && targetX === player.worldX && targetY === player.worldY && minDist < a.radius + player.radius) {
                const wildlifeDmg = Math.ceil(a.damage * mapSettingsRef.current.monsterStrengthMultiplier);
                player.hp = Math.max(0, player.hp - wildlifeDmg);
                setPlayerHp(player.hp);
              }
            } else {
              a.worldX += (Math.random() - 0.5) * 0.3;
              a.worldY += (Math.random() - 0.5) * 0.3;
            }
          } else if (a.behavior === "flying") {
            const flyAngle = Math.sin(Date.now() * 0.001 + i) * 0.5;
            a.worldX += Math.cos(flyAngle) * a.speed;
            a.worldY += Math.sin(flyAngle) * a.speed;
          }

          // Clip hit on animal
          for (let j = bullets.length - 1; j >= 0; j--) {
            const b = bullets[j];
            const bdx = b.worldX - a.worldX;
            const bdy = b.worldY - a.worldY;
            if (Math.sqrt(bdx * bdx + bdy * bdy) < a.radius + b.radius) {
              a.hp -= b.damage;
              if (a.id) {
                set(ref(db, `animals/${a.id}/hp`), a.hp);
              }
              bullets.splice(j, 1);
              if (b.id && b.shooter === currentUser) {
                remove(ref(db, `bullets/active/${b.id}`));
              }
              if (a.hp <= 0) {
                if (a.id) {
                  remove(ref(db, `animals/${a.id}`));
                  const lootId = `loot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                  set(ref(db, `loots/${lootId}`), {
                    id: lootId,
                    worldX: a.worldX,
                    worldY: a.worldY,
                    pulse: 0
                  });
                } else {
                  loots.push({ worldX: a.worldX, worldY: a.worldY, pulse: 0 });
                }
                animals.splice(i, 1);
                break;
              }
            }
          }

          if (dist > 2000) {
            if (a.id) {
              remove(ref(db, `animals/${a.id}`));
            }
            animals.splice(i, 1);
          }
        }

        // Host writes animal coordinates to DB
        if (syncThrottle === 0) {
          const updates: Record<string, any> = {};
          animals.forEach((a) => {
            if (a.id) {
              updates[`animals/${a.id}/worldX`] = a.worldX;
              updates[`animals/${a.id}/worldY`] = a.worldY;
              updates[`animals/${a.id}/hp`] = a.hp;
            }
          });
          if (Object.keys(updates).length > 0) {
            update(ref(db), updates);
          }
        }
      } else {
        // Non-host players: local damage check from animals to prevent visual latency!
        animals.forEach((a) => {
          const adx = player.worldX - a.worldX;
          const ady = player.worldY - a.worldY;
          const dist = Math.sqrt(adx * adx + ady * ady);
          if (a.behavior === "aggressive" && dist < a.vision && dist < a.radius + player.radius) {
            const wildlifeDmg = Math.ceil(a.damage * mapSettingsRef.current.monsterStrengthMultiplier);
            player.hp = Math.max(0, player.hp - wildlifeDmg);
            setPlayerHp(player.hp);
          }

          // Hit detection on animal from non-host bullets
          for (let j = bullets.length - 1; j >= 0; j--) {
            const b = bullets[j];
            if (b.shooter === currentUser) {
              const bdx = b.worldX - a.worldX;
              const bdy = b.worldY - a.worldY;
              if (Math.sqrt(bdx * bdx + bdy * bdy) < a.radius + b.radius) {
                const newHp = a.hp - b.damage;
                if (a.id) {
                  set(ref(db, `animals/${a.id}/hp`), newHp);
                }
                bullets.splice(j, 1);
                if (b.id) {
                  remove(ref(db, `bullets/active/${b.id}`));
                }
                break;
              }
            }
          }
        });
      }

      // Monsters simulation Loop
      let bossAlive = false;

      if (isHost()) {
        for (let i = enemies.length - 1; i >= 0; i--) {
          const e = enemies[i];

          if (e.type === "boss") {
            bossAlive = true;
            setBossHpPercentage((e.hp / e.maxHp) * 100);
          }

          // Nearest player selection vector
          let targetX = player.worldX;
          let targetY = player.worldY;
          let minDist = 99999;

          const distToLocal = Math.sqrt((player.worldX - e.worldX)**2 + (player.worldY - e.worldY)**2);
          if (distToLocal < minDist) {
            minDist = distToLocal;
          }

          Object.keys(otherPlayers).forEach((pName) => {
            const op = otherPlayers[pName];
            const dist = Math.sqrt((op.worldX - e.worldX)**2 + (op.worldY - e.worldY)**2);
            if (dist < minDist) {
              minDist = dist;
              targetX = op.worldX;
              targetY = op.worldY;
            }
          });

          const edx = targetX - e.worldX;
          const edy = targetY - e.worldY;
          const distToPlayer = minDist;

          // Apply Biome water speed penalty for monsters
          const eTileX = Math.floor(e.worldX / TILE_SIZE);
          const eTileY = Math.floor(e.worldY / TILE_SIZE);
          const biomeKey = `${eTileX},${eTileY}`;
          
          const estTile =
            mapSettingsRef.current.tiles[biomeKey] ||
            getNoiseTileAt(eTileX, eTileY, mapSettingsRef.current.width, mapSettingsRef.current.height);

          let finalEnemySpeed = e.speed;
          if (estTile === "WATER" && e.type !== "stalker") {
            finalEnemySpeed *= 0.52;
          }

          finalEnemySpeed *= mapSettingsRef.current.monsterAggressionMultiplier;
          finalEnemySpeed *= e.rageMode || 1.0;

          const scaledVision = e.visionRadius * mapSettingsRef.current.monsterAggressionMultiplier;
          const scaledLoseTarget = e.loseTargetRadius * mapSettingsRef.current.monsterAggressionMultiplier;

          if (e.state === "calm") {
            e.shakeX = 0;
            e.shakeY = 0;
            e.walkTimer--;

            if (e.walkTimer <= 0) {
              e.walkTimer = 160 + Math.random() * 200;
              if (Math.random() < 0.6) {
                e.isWalking = true;
                const randAngle = Math.random() * Math.PI * 2;
                const randDist = 60 + Math.random() * 120;
                e.targetWalkX = e.worldX + Math.cos(randAngle) * randDist;
                e.targetWalkY = e.worldY + Math.sin(randAngle) * randDist;
              } else {
                e.isWalking = false;
              }
            }

            if (e.isWalking) {
              const tdx = e.targetWalkX - e.worldX;
              const tdy = e.targetWalkY - e.worldY;
              const tDist = Math.sqrt(tdx * tdx + tdy * tdy);
              if (tDist > 4) {
                e.worldX += (tdx / tDist) * (finalEnemySpeed * 0.45);
                e.worldY += (tdy / tDist) * (finalEnemySpeed * 0.45);
              } else {
                e.isWalking = false;
              }
            }

            if (distToPlayer < scaledVision) {
              e.state = "nervous";
            }
          } else if (e.state === "nervous") {
            e.shakeX = (Math.random() - 0.5) * 6;
            e.shakeY = (Math.random() - 0.5) * 6;
            
            // Momenty reagowania - alert progress rate depends on player class and movement!
            let alertRate = 1.6;
            if (player.isRunning && isMoving) {
              alertRate *= 2.2; // Rapid sprint alerts 2.2x quicker
            } else if (!isMoving) {
              alertRate *= 0.5; // Standing still alerts 2x slower
            }
            if (charClass === "lucznik") {
              alertRate *= 0.7; // Archers are silent, 30% slower trigger
            } else if (charClass === "wojownik") {
              alertRate *= 1.35; // Heavy warriors trigger beasts 35% faster
            }
            
            e.alertProgress += alertRate;

            if (e.alertProgress >= 100) {
              e.state = "aggressive";
              e.shakeX = 0;
              e.shakeY = 0;
              alertNearbyEnemies(e);
            }

            if (distToPlayer > scaledVision + 30) {
              e.alertProgress -= 2.2;
              if (e.alertProgress <= 0) {
                e.alertProgress = 0;
                e.state = "calm";
              }
            }
          } else if (e.state === "aggressive") {
            e.dynamicTimer += 0.055;
            const waveOffset = Math.sin(e.dynamicTimer + e.aiSeed) * 1.55;
            const approachAngle = Math.atan2(edy, edx);

            if (e.type === "boss") {
              e.bossTimer++;
              if (e.bossActionState === "none" && e.bossTimer > 200) {
                e.bossActionState = "preparing";
                e.bossTimer = 0;
              }

              if (e.bossActionState === "preparing") {
                e.shakeX = (Math.random() - 0.5) * 12;
                e.shakeY = (Math.random() - 0.5) * 12;
                if (e.bossTimer > 55) {
                  e.bossActionState = "charging";
                  e.bossTimer = 0;
                  const chargeAngle = Math.atan2(edy, edx);
                  e.chargeVx = Math.cos(chargeAngle) * 13.5;
                  e.chargeVy = Math.sin(chargeAngle) * 13.5;
                  triggerCameraShake(25, 9);
                }
              } else if (e.bossActionState === "charging") {
                e.worldX += e.chargeVx;
                e.worldY += e.chargeVy;
                if (e.bossTimer > 35) {
                  e.bossActionState = "none";
                  e.bossTimer = 0;
                  e.shakeX = 0;
                  e.shakeY = 0;
                }
              } else {
                if (distToPlayer > 5) {
                  e.worldX += Math.cos(approachAngle + waveOffset * 0.18) * finalEnemySpeed;
                  e.worldY += Math.sin(approachAngle + waveOffset * 0.18) * finalEnemySpeed;
                }
              }
            } else if (e.type === "ranger") {
              const orbitAngle = approachAngle + Math.PI / 2 + waveOffset * 0.12;

              if (distToPlayer > 250) {
                e.worldX += Math.cos(approachAngle) * finalEnemySpeed;
                e.worldY += Math.sin(approachAngle) * finalEnemySpeed;
              } else if (distToPlayer < 180) {
                e.worldX -= Math.cos(approachAngle) * finalEnemySpeed;
                e.worldY -= Math.sin(approachAngle) * finalEnemySpeed;
              } else {
                e.worldX += Math.cos(orbitAngle) * (finalEnemySpeed * 0.85);
                e.worldY += Math.sin(orbitAngle) * (finalEnemySpeed * 0.85);
              }

              e.shootCooldown++;

              if (e.shootCooldown > 55) {
                e.shootCooldown = 0;
                const shootAngle = Math.atan2(edy, edx);
                enemyBullets.push({
                  worldX: e.worldX,
                  worldY: e.worldY,
                  vx: Math.cos(shootAngle - 0.12) * 6.5,
                  vy: Math.sin(shootAngle - 0.12) * 6.5,
                  radius: 4,
                  life: 80
                });
                enemyBullets.push({
                  worldX: e.worldX,
                  worldY: e.worldY,
                  vx: Math.cos(shootAngle + 0.12) * 6.5,
                  vy: Math.sin(shootAngle + 0.12) * 6.5,
                  radius: 4,
                  life: 80
                });
              }
            } else if (e.type === "stalker") {
              e.teleportCooldown++;

              if (e.teleportCooldown > 135 && distToPlayer > 130) {
                e.teleportCooldown = 0;
                const telAngle = approachAngle + (Math.random() > 0.5 ? 0.65 : -0.65);
                e.worldX = targetX - Math.cos(telAngle) * 105;
                e.worldY = targetY - Math.sin(telAngle) * 105;
                visualEffects.push({
                  type: "slash",
                  worldX: e.worldX,
                  worldY: e.worldY,
                  angle: telAngle,
                  side: 1,
                  life: 6,
                  maxLife: 6
                });
              } else {
                e.worldX += Math.cos(approachAngle + waveOffset * 0.35) * finalEnemySpeed;
                e.worldY += Math.sin(approachAngle + waveOffset * 0.35) * finalEnemySpeed;
              }
            } else if (e.type === "shaman") {
              if (distToPlayer < 230) {
                e.worldX -= Math.cos(approachAngle) * finalEnemySpeed;
                e.worldY -= Math.sin(approachAngle) * finalEnemySpeed;
              } else if (distToPlayer > 330) {
                e.worldX += Math.cos(approachAngle) * finalEnemySpeed;
                e.worldY += Math.sin(approachAngle) * finalEnemySpeed;
              } else {
                e.worldX += Math.cos(approachAngle + Math.PI / 2) * finalEnemySpeed;
                e.worldY += Math.sin(approachAngle + Math.PI / 2) * finalEnemySpeed;
              }

              e.healCooldown++;

              if (e.healCooldown > 85) {
                e.healCooldown = 0;
                enemies.forEach((other) => {
                  if (other !== e && Math.abs(other.worldX - e.worldX) < 220 && Math.abs(other.worldY - e.worldY) < 220) {
                    other.hp = Math.min(other.maxHp, other.hp + 30);
                    other.rageMode = 1.35;
                  }
                });
              }
            } else if (e.type === "tank") {
              e.slamTimer = e.slamTimer || 0;
              e.slamTimer++;
              
              if (e.isSlamPrepping) {
                finalEnemySpeed = 0; // Stationary while charging
                e.slamPrepFrame = (e.slamPrepFrame || 0) - 1;
                if (e.slamPrepFrame <= 0) {
                  e.isSlamPrepping = false;
                  // Slam explosion!
                  visualEffects.push({
                    type: "ground_slam",
                    worldX: e.worldX,
                    worldY: e.worldY,
                    radius: 10,
                    maxRadius: 130,
                    life: 20,
                    maxLife: 20
                  });
                  triggerCameraShake(18, 5.5);
                  if (distToPlayer < 130 && dashActiveTimer <= 0) {
                    const hitDmg = Math.ceil(24 * mapSettingsRef.current.monsterStrengthMultiplier);
                    player.hp = Math.max(0, player.hp - hitDmg);
                    setPlayerHp(player.hp);
                    // Knockback player slightly
                    const knockAngle = Math.atan2(player.worldY - e.worldY, player.worldX - e.worldX);
                    player.worldX += Math.cos(knockAngle) * 35;
                    player.worldY += Math.sin(knockAngle) * 35;
                  }
                }
              } else {
                if (e.slamTimer > 180 && distToPlayer < 120) {
                  e.isSlamPrepping = true;
                  e.slamPrepFrame = 35;
                  e.slamTimer = 0;
                  finalEnemySpeed = 0;
                } else if (distToPlayer > 5) {
                  e.worldX += Math.cos(approachAngle + waveOffset * 0.12) * finalEnemySpeed;
                  e.worldY += Math.sin(approachAngle + waveOffset * 0.12) * finalEnemySpeed;
                }
              }
            } else if (e.type === "classic") {
              e.leapCooldown = e.leapCooldown || 0;
              if (e.leapCooldown > 0) e.leapCooldown--;

              if (e.leapActiveTimer > 0) {
                e.leapActiveTimer--;
                // Lunges forward rapidly
                e.worldX += Math.cos(e.leapAngle) * (finalEnemySpeed * 2.6);
                e.worldY += Math.sin(e.leapAngle) * (finalEnemySpeed * 2.6);
              } else {
                if (e.leapCooldown <= 0 && distToPlayer < 115) {
                  e.leapActiveTimer = 16;
                  e.leapAngle = approachAngle;
                  e.leapCooldown = 140;
                } else if (distToPlayer > 5) {
                  e.worldX += Math.cos(approachAngle + waveOffset * 0.28) * finalEnemySpeed;
                  e.worldY += Math.sin(approachAngle + waveOffset * 0.28) * finalEnemySpeed;
                }
              }
            } else {
              if (distToPlayer > 5) {
                const xtraDash =
                  e.type === "runner" && distToPlayer < 100 && Math.floor(Date.now() / 400) % 2 === 0 ? 1.55 : 1.0;
                e.worldX += Math.cos(approachAngle + waveOffset * 0.28) * finalEnemySpeed * xtraDash;
                e.worldY += Math.sin(approachAngle + waveOffset * 0.28) * finalEnemySpeed * xtraDash;
              }
            }

            if (distToPlayer > scaledLoseTarget && e.type !== "boss") {
              e.state = "calm";
              e.alertProgress = 0;
              e.rageMode = 1.0;
            }

            if (dashActiveTimer <= 0 && targetX === player.worldX && targetY === player.worldY && distToPlayer < e.radius + player.radius) {
              const hitDamage = Math.ceil(e.damage * mapSettingsRef.current.monsterStrengthMultiplier);
              player.hp = Math.max(0, player.hp - hitDamage);
              setPlayerHp(player.hp);
              triggerCameraShake(10, 3);

              if (player.hp <= 0) {
                alert(`Koniec Gry! Twój osiągnięty poziom: ${player.level}. Wybierz klasę i zagraj jeszcze raz!`);
                player.hp = 100;
                player.level = 1;
                player.xp = 0;
                player.xpNeeded = 100;
                player.skillPoints = 0;
                setScore(0);
                statsRef.current.score = 0;
                enemies.length = 0;
                bullets.length = 0;
                enemyBullets.length = 0;
                setBossUiActive(false);

                setPlayerHp(player.hp);
                setPlayerLvl(player.level);
                setPlayerXp(player.xp);
                setPlayerXpNeeded(player.xpNeeded);
                onGameStatsUpdated(1, 0);
                remove(ref(db, `players/${currentUser}`));
              }
            }
          }

          // Projectiles collision detection on this monster in Host context
          for (let j = bullets.length - 1; j >= 0; j--) {
            const b = bullets[j];
            const bdx = b.worldX - e.worldX;
            const bdy = b.worldY - e.worldY;

            if (Math.sqrt(bdx * bdx + bdy * bdy) < e.radius + b.radius) {
              e.hp = Math.max(0, e.hp - b.damage);
              bullets.splice(j, 1);
              if (b.id && b.shooter === currentUser) {
                remove(ref(db, `bullets/active/${b.id}`));
              }

              if (e.state !== "aggressive") {
                e.state = "aggressive";
                e.alertProgress = 100;
              }
              alertNearbyEnemies(e);

              if (e.hp <= 0) {
                if (e.type === "boss") setBossUiActive(false);
                enemies.splice(i, 1);
                if (e.id) {
                  remove(ref(db, `monsters/${e.id}`));
                  const lootId = `loot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                  set(ref(db, `loots/${lootId}`), {
                    id: lootId,
                    worldX: e.worldX,
                    worldY: e.worldY,
                    pulse: 0
                  });
                }
                handleGainScore(e.xpReward);
                break;
              }
            }
          }
        }

        // Host writes monster coordinates to DB
        if (syncThrottle === 0) {
          const updates: Record<string, any> = {};
          enemies.forEach((e) => {
            if (e.id) {
              updates[`monsters/${e.id}/worldX`] = e.worldX;
              updates[`monsters/${e.id}/worldY`] = e.worldY;
              updates[`monsters/${e.id}/hp`] = e.hp;
              updates[`monsters/${e.id}/state`] = e.state;
              updates[`monsters/${e.id}/alertProgress`] = e.alertProgress;
            }
          });
          if (Object.keys(updates).length > 0) {
            update(ref(db), updates);
          }
        }
      } else {
        // Non-host player: local hit calculation and quick damage to guarantee beautiful feedback!
        enemies.forEach((e) => {
          if (e.type === "boss") {
            bossAlive = true;
            setBossHpPercentage((e.hp / e.maxHp) * 100);
          }

          const edx = player.worldX - e.worldX;
          const edy = player.worldY - e.worldY;
          const distToPlayer = Math.sqrt(edx * edx + edy * edy);

          if (dashActiveTimer <= 0 && e.state === "aggressive" && distToPlayer < e.radius + player.radius) {
            const hitDamage = Math.ceil(e.damage * mapSettingsRef.current.monsterStrengthMultiplier);
            player.hp = Math.max(0, player.hp - hitDamage);
            setPlayerHp(player.hp);
            triggerCameraShake(10, 3);

            if (player.hp <= 0) {
              alert(`Koniec Gry! Twój osiągnięty poziom: ${player.level}. Wybierz klasę i zagraj jeszcze raz!`);
              player.hp = 100;
              player.level = 1;
              player.xp = 0;
              player.xpNeeded = 100;
              player.skillPoints = 0;
              setScore(0);
              statsRef.current.score = 0;
              enemies.length = 0;
              bullets.length = 0;
              enemyBullets.length = 0;
              setBossUiActive(false);

              setPlayerHp(player.hp);
              setPlayerLvl(player.level);
              setPlayerXp(player.xp);
              setPlayerXpNeeded(player.xpNeeded);
              onGameStatsUpdated(1, 0);
              remove(ref(db, `players/${currentUser}`));
            }
          }

          for (let j = bullets.length - 1; j >= 0; j--) {
            const b = bullets[j];
            if (b.shooter === currentUser) {
              const bdx = b.worldX - e.worldX;
              const bdy = b.worldY - e.worldY;
              if (Math.sqrt(bdx * bdx + bdy * bdy) < e.radius + b.radius) {
                const newHp = Math.max(0, e.hp - b.damage);
                if (e.id) {
                  set(ref(db, `monsters/${e.id}/hp`), newHp);
                  if (newHp <= 0) {
                    remove(ref(db, `monsters/${e.id}`));
                    const lootId = `loot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                    set(ref(db, `loots/${lootId}`), {
                      id: lootId,
                      worldX: e.worldX,
                      worldY: e.worldY,
                      pulse: 0
                    });
                    handleGainScore(e.xpReward);
                  }
                }
                bullets.splice(j, 1);
                if (b.id) {
                  remove(ref(db, `bullets/active/${b.id}`));
                }
                break;
              }
            }
          }
        });
      }

      setBossUiActive(bossAlive);

      // Save stats in refs for minimap rendering
      playerRef.current = { worldX: player.worldX, worldY: player.worldY };
      otherPlayersRef.current = otherPlayers;
      enemiesRef.current = enemies;

      if (camShakeTime > 0) camShakeTime--;
    };

    // Rendering Canvas components
    const renderWorkspace = () => {
      let currentShakeX = 0;
      let currentShakeY = 0;

      if (camShakeTime > 0) {
        currentShakeX = (Math.random() - 0.5) * camShakeIntensity;
        currentShakeY = (Math.random() - 0.5) * camShakeIntensity;
      }

      // Backdrop fill
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Camera coordinates offset
      const cameraX = player.worldX - screenCenterX + currentShakeX;
      const cameraY = player.worldY - screenCenterY + currentShakeY;

      // Determine viewport ranges
      const startTileX = Math.floor(cameraX / TILE_SIZE);
      const endTileX = Math.ceil((cameraX + canvas.width) / TILE_SIZE);
      const startTileY = Math.floor(cameraY / TILE_SIZE);
      const endTileY = Math.ceil((cameraY + canvas.height) / TILE_SIZE);

      // Draw custom & procedural tiles inside viewport
      for (let y = startTileY; y <= endTileY; y++) {
        for (let x = startTileX; x <= endTileX; x++) {
          if (x < 0 || x >= mapSettingsRef.current.width || y < 0 || y >= mapSettingsRef.current.height) {
            // Out of bounds background
            continue;
          }

          const customKey = `${x},${y}`;
          const currentMapTile =
            mapSettingsRef.current.tiles[customKey] ||
            getNoiseTileAt(x, y, mapSettingsRef.current.width, mapSettingsRef.current.height);

          const tileObj = BIOMES[currentMapTile];

          const rx = Math.round(x * TILE_SIZE - cameraX);
          const ry = Math.round(y * TILE_SIZE - cameraY);

          // Render gradients
          const grad = ctx.createRadialGradient(rx + 32, ry + 32, 6, rx + 32, ry + 32, 45);
          grad.addColorStop(0, tileObj.c1);
          grad.addColorStop(1, tileObj.c2);
          ctx.fillStyle = grad;
          ctx.fillRect(rx, ry, TILE_SIZE, TILE_SIZE);

          // Procedural elements rendering
          const pSeed = MathNoise(x, y);

          if (currentMapTile === "WATER" && pSeed < 0.12) {
            ctx.fillStyle = "#1e8449";
            ctx.beginPath();
            ctx.arc(rx + 32 + pSeed * 20, ry + 32 - pSeed * 20, 8, 0, Math.PI * 1.7);
            ctx.fill();
          } else if ((currentMapTile === "GRASS" || currentMapTile === "RAINFOREST") && pSeed < 0.25) {
            if (pSeed < 0.08) {
              const color = pSeed < 0.03 ? "#ff3366" : pSeed < 0.06 ? "#33ccff" : "#ffcc00";
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(rx + 20 + pSeed * 30, ry + 20 + pSeed * 30, 4, 0, Math.PI * 2);
              ctx.fill();
            } else {
              ctx.strokeStyle = "#1b5e20";
              ctx.lineWidth = 2;
              ctx.beginPath();
              const tx = rx + 15 + pSeed * 30;
              const ty = ry + 40;
              ctx.moveTo(tx, ty);
              ctx.lineTo(tx - 3, ty - 12);
              ctx.moveTo(tx, ty);
              ctx.lineTo(tx, ty - 15);
              ctx.moveTo(tx, ty);
              ctx.lineTo(tx + 4, ty - 10);
              ctx.stroke();
            }
          } else if ((currentMapTile === "FOREST" || currentMapTile === "MOUNTAIN") && pSeed < 0.18) {
            const ox = rx + 32;
            const oy = ry + 32;
            if (pSeed < 0.09) {
              ctx.fillStyle = "rgba(0,0,0,0.3)";
              ctx.beginPath();
              ctx.ellipse(ox + 5, oy + 5, 12, 6, 0, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = "#5d4037";
              ctx.beginPath();
              ctx.arc(ox, oy, 10, 0, Math.PI * 2);
              ctx.fill();
            } else {
              ctx.fillStyle = "rgba(0,0,0,0.3)";
              ctx.beginPath();
              ctx.ellipse(ox + 4, oy + 4, 14, 8, 0, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = "#9e9e9e";
              ctx.beginPath();
              ctx.arc(ox, oy, 9, 0, Math.PI * 2);
              ctx.fill();
            }
          }

          // Optional: Draw subtle grid lines if Admin is active so they can edit tiles perfectly!
          if (isAdminActive) {
            ctx.strokeStyle = "rgba(0, 255, 204, 0.07)";
            ctx.lineWidth = 1;
            ctx.strokeRect(rx, ry, TILE_SIZE, TILE_SIZE);
          }
        }
      }

      // Render wildlife fishes
      fishes.forEach((f) => {
        const fTileX = Math.floor(f.worldX / TILE_SIZE);
        const fTileY = Math.floor(f.worldY / TILE_SIZE);
        const key = `${fTileX},${fTileY}`;
        const currentTile =
          mapSettingsRef.current.tiles[key] ||
          getNoiseTileAt(fTileX, fTileY, mapSettingsRef.current.width, mapSettingsRef.current.height);

        if (currentTile === "WATER") {
          ctx.save();
          ctx.translate(Math.round(f.worldX - cameraX), Math.round(f.worldY - cameraY));
          ctx.rotate(f.angle);
          ctx.fillStyle = "#ff7675";
          ctx.beginPath();
          ctx.ellipse(0, 0, 6, 3, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });

      // Render spawnpoints explicitly ONLY for Admin's eyes!
      if (isAdminActive) {
        mapSettingsRef.current.spawns.forEach((s) => {
          const sx = Math.round(s.x * TILE_SIZE + 32 - cameraX);
          const sy = Math.round(s.y * TILE_SIZE + 32 - cameraY);
          
          // Draw spawn flag or circle
          ctx.save();
          ctx.fillStyle = "rgba(124, 58, 237, 0.25)";
          ctx.strokeStyle = "#8b5cf6";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(sx, sy, 22, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 9px monospace";
          ctx.shadowBlur = 4;
          ctx.shadowColor = "#000000";
          ctx.textAlign = "center";
          ctx.fillText(s.monsterType.toUpperCase(), sx, sy - 4);
          ctx.fillText(`(${s.x},${s.y})`, sx, sy + 6);
          ctx.restore();
        });
      }

      // Render loot items on ground
      loots.forEach((l) => {
        l.pulse += 0.08;
        const sizeMod = Math.sin(l.pulse) * 1.8;
        const lx = Math.round(l.worldX - cameraX);
        const ly = Math.round(l.worldY - cameraY);

        ctx.fillStyle = "#d63031";
        ctx.beginPath();
        ctx.arc(lx, ly, 8 + sizeMod, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(lx - 2, ly - 2, 4, 9);
      });

      // Render peaceful animals
      animals.forEach((a) => {
        let ax = Math.round(a.worldX - cameraX);
        let ay = Math.round(a.worldY - cameraY);
        if (a.behavior === "flying") {
          ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
          ctx.beginPath();
          ctx.arc(ax, ay + a.heightOffset, a.radius * 0.8, 0, Math.PI * 2);
          ctx.fill();
          ay -= a.heightOffset;
        } else {
          ctx.fillStyle = "rgba(0,0,0,0.15)";
          ctx.beginPath();
          ctx.ellipse(ax + 3, ay + 3, a.radius, a.radius * 0.5, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = a.color;
        ctx.beginPath();
        ctx.arc(ax, ay, a.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#2d3436";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });

      // Render player energy projectives
      bullets.forEach((b) => {
        const bx = Math.round(b.worldX - cameraX);
        const by = Math.round(b.worldY - cameraY);

        if (b.type === "energy_ball") {
          ctx.save();
          ctx.shadowColor = "#00d2ff";
          ctx.shadowBlur = 15;

          ctx.strokeStyle = "rgba(51, 204, 255, 0.65)";
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.ellipse(bx, by, b.radius * 2.2, b.radius * 0.8, b.animFrame * 0.15, 0, Math.PI * 2);
          ctx.stroke();

          ctx.beginPath();
          ctx.ellipse(bx, by, b.radius * 0.8, b.radius * 2.2, -b.animFrame * 0.2, 0, Math.PI * 2);
          ctx.stroke();

          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let i = 0; i < 4; i++) {
            const len = b.radius * (1.2 + Math.random() * 0.8);
            const ang = (Math.PI / 2) * i + (Math.random() - 0.5);
            ctx.moveTo(bx, by);
            ctx.lineTo(bx + Math.cos(ang) * len, by + Math.sin(ang) * len);
          }
          ctx.stroke();

          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(bx, by, b.radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else if (b.type === "arrow") {
          ctx.save();
          ctx.translate(bx, by);
          ctx.rotate(b.angle);
          ctx.strokeStyle = "#f39c12";
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(-10, 0);
          ctx.lineTo(8, 0);
          ctx.stroke();
          ctx.fillStyle = "#ecf0f1";
          ctx.beginPath();
          ctx.moveTo(-10, -3.5);
          ctx.lineTo(-14, -5.5);
          ctx.lineTo(-11.5, 0);
          ctx.lineTo(-14, 5.5);
          ctx.lineTo(-10, 3.5);
          ctx.fill();
          ctx.restore();
        } else if (b.type === "poison_arrow") {
          ctx.save();
          ctx.translate(bx, by);
          ctx.rotate(b.angle);
          ctx.shadowColor = "#2ecc71";
          ctx.shadowBlur = 12;
          ctx.strokeStyle = "#2ecc71";
          ctx.lineWidth = 3.5;
          ctx.beginPath();
          ctx.moveTo(-12, 0);
          ctx.lineTo(10, 0);
          ctx.stroke();

          // arrowhead
          ctx.fillStyle = "#27ae60";
          ctx.beginPath();
          ctx.moveTo(10, 0);
          ctx.lineTo(4, -3);
          ctx.lineTo(4, 3);
          ctx.fill();
          ctx.restore();
        } else if (b.type === "hurricane_arrow") {
          ctx.save();
          ctx.translate(bx, by);
          ctx.rotate(b.angle);
          ctx.shadowColor = "#58d68d";
          ctx.shadowBlur = 18;
          ctx.strokeStyle = "#2ecc71";
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.moveTo(-18, 0);
          ctx.lineTo(18, 0);
          ctx.stroke();

          ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
          ctx.lineWidth = 1.5;
          ctx.rotate(Date.now() * 0.05);
          ctx.beginPath();
          ctx.arc(0, 0, 11, 0, Math.PI);
          ctx.stroke();
          ctx.restore();
        } else if (b.type === "arcane_beam") {
          ctx.save();
          ctx.translate(bx, by);
          ctx.rotate(b.angle);
          ctx.shadowColor = "#8e44ad";
          ctx.shadowBlur = 24;

          const grad = ctx.createLinearGradient(-35, 0, 35, 0);
          grad.addColorStop(0, "rgba(142, 68, 173, 0.2)");
          grad.addColorStop(0.5, "#ffffff");
          grad.addColorStop(1, "rgba(51, 204, 255, 0.2)");

          ctx.strokeStyle = grad;
          ctx.lineWidth = 14;
          ctx.beginPath();
          ctx.moveTo(-35, 0);
          ctx.lineTo(35, 0);
          ctx.stroke();

          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(0, 0, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });

      // Play visual sweep effects
      visualEffects.forEach((fx) => {
        if (fx.type === "slash") {
          ctx.save();
          ctx.translate(Math.round(fx.worldX - cameraX), Math.round(fx.worldY - cameraY));
          ctx.rotate(fx.angle);

          const alpha = fx.life / fx.maxLife;
          ctx.strokeStyle = `rgba(255, 51, 51, ${alpha})`;
          ctx.lineWidth = 5;
          ctx.shadowBlur = 10;
          ctx.shadowColor = "#ff0000";
          ctx.beginPath();
          ctx.arc(15, 0, 45, -Math.PI / 3, Math.PI / 3, false);
          ctx.stroke();
          ctx.restore();
        } else if (fx.type === "frost_nova") {
          const progress = 1 - (fx.life / 25);
          const currentRadius = fx.radius + (fx.maxRadius - fx.radius) * progress;
          ctx.save();
          ctx.beginPath();
          ctx.arc(Math.round(fx.worldX - cameraX), Math.round(fx.worldY - cameraY), currentRadius, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(0, 210, 255, ${fx.life / 25})`;
          ctx.lineWidth = 4;
          ctx.shadowBlur = 16;
          ctx.shadowColor = "#00d2ff";
          ctx.stroke();

          ctx.fillStyle = `rgba(0, 210, 255, ${(fx.life / 25) * 0.15})`;
          ctx.fill();
          ctx.restore();
        } else if (fx.type === "ground_slam") {
          const progress = 1 - (fx.life / 25);
          const currentRadius = fx.radius + (fx.maxRadius - fx.radius) * progress;
          ctx.save();
          ctx.beginPath();
          ctx.arc(Math.round(fx.worldX - cameraX), Math.round(fx.worldY - cameraY), currentRadius, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(230, 126, 34, ${fx.life / 25})`;
          ctx.lineWidth = 6;
          ctx.shadowBlur = 20;
          ctx.shadowColor = "#ff5500";
          ctx.stroke();

          ctx.strokeStyle = `rgba(255, 51, 51, ${fx.life / 25})`;
          ctx.lineWidth = 2.5;
          for (let k = 0; k < 8; k++) {
            const angle = (Math.PI / 4) * k;
            ctx.beginPath();
            ctx.moveTo(Math.round(fx.worldX - cameraX), Math.round(fx.worldY - cameraY));
            ctx.lineTo(
              Math.round(fx.worldX - cameraX) + Math.cos(angle) * currentRadius,
              Math.round(fx.worldY - cameraY) + Math.sin(angle) * currentRadius
            );
            ctx.stroke();
          }
          ctx.restore();
        } else if (fx.type === "blade_whirl") {
          ctx.save();
          ctx.translate(Math.round(fx.worldX - cameraX), Math.round(fx.worldY - cameraY));
          ctx.rotate(Date.now() * 0.015);
          const alpha = fx.life / 50;
          ctx.strokeStyle = `rgba(241, 196, 15, ${alpha})`;
          ctx.shadowColor = "#f1c40f";
          ctx.shadowBlur = 15;
          ctx.lineWidth = 5;
          for (let k = 0; k < 3; k++) {
            ctx.rotate((Math.PI * 2) / 3);
            ctx.beginPath();
            ctx.arc(0, 0, 75, 0, Math.PI / 2);
            ctx.stroke();
          }
          ctx.restore();
        } else if (fx.type === "lava_explosion") {
          const progress = 1 - (fx.life / 35);
          const currentRadius = fx.radius + (fx.maxRadius - fx.radius) * progress;
          ctx.save();
          ctx.beginPath();
          ctx.arc(Math.round(fx.worldX - cameraX), Math.round(fx.worldY - cameraY), currentRadius, 0, Math.PI * 2);
          const grad = ctx.createRadialGradient(
            Math.round(fx.worldX - cameraX), Math.round(fx.worldY - cameraY), 10,
            Math.round(fx.worldX - cameraX), Math.round(fx.worldY - cameraY), currentRadius
          );
          grad.addColorStop(0, `rgba(255, 60, 0, ${fx.life / 35})`);
          grad.addColorStop(0.5, `rgba(243, 156, 18, ${(fx.life / 35) * 0.75})`);
          grad.addColorStop(1, "rgba(255, 0, 0, 0)");
          ctx.fillStyle = grad;
          ctx.fill();
          ctx.restore();
        } else if (fx.type === "arrow_gale") {
          const alpha = fx.life / 60;
          ctx.save();
          ctx.translate(Math.round(fx.worldX - cameraX), Math.round(fx.worldY - cameraY));
          ctx.rotate(Date.now() * 0.008);
          ctx.strokeStyle = `rgba(46, 204, 113, ${alpha})`;
          ctx.lineWidth = 3;
          ctx.shadowColor = "#2ecc71";
          ctx.shadowBlur = 18;
          ctx.beginPath();
          ctx.arc(0, 0, 95, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        } else if (fx.type === "dash_ghost") {
          ctx.save();
          ctx.translate(Math.round(fx.worldX - cameraX), Math.round(fx.worldY - cameraY));
          ctx.rotate(fx.angle);
          ctx.beginPath();
          ctx.arc(0, 0, 16, 0, Math.PI * 2);
          const alpha = (fx.life / fx.maxLife) * 0.45;
          if (fx.charClass === "mag") ctx.fillStyle = `rgba(0, 210, 255, ${alpha})`;
          else if (fx.charClass === "wojownik") ctx.fillStyle = `rgba(255, 51, 51, ${alpha})`;
          else if (fx.charClass === "lucznik") ctx.fillStyle = `rgba(46, 204, 113, ${alpha})`;
          else ctx.fillStyle = `rgba(140, 140, 140, ${alpha})`;
          ctx.fill();
          ctx.restore();
        } else if (fx.type === "damage_flash") {
          ctx.save();
          const progress = 1 - (fx.life / fx.maxLife);
          const drawX = Math.round(fx.worldX - cameraX);
          const drawY = Math.round(fx.worldY - cameraY - progress * 40);
          ctx.fillStyle = fx.color || "#ff3333";
          ctx.font = `bold ${fx.isCrit ? 20 : 13}px "JetBrains Mono", monospace`;
          ctx.shadowColor = "black";
          ctx.shadowBlur = 4;
          ctx.textAlign = "center";
          ctx.fillText(fx.text || "", drawX, drawY);
          ctx.restore();
        }
      });

      // Play enemy projectiles
      enemyBullets.forEach((eb) => {
        ctx.save();
        ctx.shadowColor = "#ff00ff";
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(Math.round(eb.worldX - cameraX), Math.round(eb.worldY - cameraY), eb.radius, 0, Math.PI * 2);
        ctx.fillStyle = "#df00ff";
        ctx.fill();
        ctx.restore();
      });

      // Draw aggressive & passive monsters
      enemies.forEach((e) => {
        const scrX = Math.round(e.worldX - cameraX + e.shakeX);
        const scrY = Math.round(e.worldY - cameraY + e.shakeY);
        ctx.save();

        // Stalker stealth opacity
        if (e.type === "stalker" && e.state === "aggressive") {
          ctx.globalAlpha = 0.35;
        }

        ctx.beginPath();
        ctx.arc(scrX, scrY, e.radius, 0, Math.PI * 2);
        if (e.type === "boss") {
          if (e.bossActionState === "preparing" && Math.floor(Date.now() / 70) % 2 === 0) {
            ctx.fillStyle = "#ff3300";
          } else {
            ctx.fillStyle = "#2980b9";
          }
        } else {
          ctx.fillStyle = e.state === "aggressive" ? e.agroColor : e.color;
        }

        ctx.fill();
        ctx.strokeStyle = "#111";
        ctx.lineWidth = e.type === "boss" ? 4 : 2;
        ctx.stroke();

        // Rage speed buff halo from shaman spell
        if (e.rageMode > 1.0) {
          ctx.strokeStyle = "#e67e22";
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(scrX, scrY, e.radius + 5, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Shaman healing area visual indicator
        if (e.type === "shaman") {
          ctx.strokeStyle = "rgba(46, 204, 113, 0.16)";
          ctx.fillStyle = "rgba(46, 204, 113, 0.03)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(scrX, scrY, 220, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          
          // Draw a small healing cross near the head
          if (Math.floor(Date.now() / 450) % 2 === 0) {
            ctx.fillStyle = "#2ecc71";
            ctx.font = "bold 9px monospace";
            ctx.fillText("+", scrX - 3, scrY - e.radius - 20);
          }
        }

        // Tank Ground Slam telegraph indicator
        if (e.type === "tank" && e.isSlamPrepping) {
          const progress = (35 - (e.slamPrepFrame || 0)) / 35;
          ctx.strokeStyle = "rgba(231, 76, 60, 0.75)";
          ctx.fillStyle = "rgba(231, 76, 60, 0.18)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(scrX, scrY, progress * 130, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }

        // Classic leap speed trail indicator
        if (e.type === "classic" && e.leapActiveTimer > 0) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(scrX - Math.cos(e.leapAngle) * 15, scrY - Math.sin(e.leapAngle) * 15, e.radius * 0.85, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.restore();

        // Enemy health indicators
        const barW = e.radius * 2.2;
        const barH = 4.5;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(scrX - barW / 2, scrY - e.radius - 12, barW, barH);
        ctx.fillStyle = "#00ffcc";
        ctx.fillRect(scrX - barW / 2, scrY - e.radius - 12, barW * (e.hp / e.maxHp), barH);
      });

      // Draw other online players downloaded from Firebase
      Object.keys(otherPlayers).forEach((pName) => {
        const op = otherPlayers[pName];
        if (!op) return;
        const opx = Math.round(op.worldX - cameraX);
        const opy = Math.round(op.worldY - cameraY);

        if (opx > -50 && opx < canvas.width + 50 && opy > -50 && opy < canvas.height + 50) {
          ctx.save();
          ctx.translate(opx, opy);
          ctx.rotate(op.angle || 0);

          ctx.beginPath();
          ctx.arc(0, 0, 16, 0, Math.PI * 2);
          if (op.charClass === "mag") ctx.fillStyle = "#00d2ff";
          else if (op.charClass === "wojownik") ctx.fillStyle = "#ff3333";
          else if (op.charClass === "lucznik") ctx.fillStyle = "#2ecc71";
          else ctx.fillStyle = "#95a5a6";
          ctx.fill();
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2.5;
          ctx.stroke();

          // draw relative weaponry of other players
          if (op.charClass === "mag") {
            ctx.fillStyle = "#8e44ad";
            ctx.fillRect(8, -4, 26, 6);
            ctx.fillStyle = "#33ccff";
            ctx.beginPath();
            ctx.arc(28, -1, 5, 0, Math.PI * 2);
            ctx.fill();
          } else if (op.charClass === "wojownik") {
            ctx.fillStyle = "#7f8c8d";
            ctx.fillRect(5, -3, 36, 6);
            ctx.fillStyle = "#f1c40f";
            ctx.fillRect(5, -5, 3, 10);
          } else if (op.charClass === "lucznik") {
            ctx.strokeStyle = "#d35400";
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(14, 0, 14, -Math.PI / 2, Math.PI / 2);
            ctx.stroke();
          }

          ctx.restore();

          // HP and Name tag indicator
          ctx.save();
          ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
          ctx.fillRect(opx - 30, opy - 32, 60, 4);
          ctx.fillStyle = "#2ecc71";
          ctx.fillRect(opx - 30, opy - 32, 60 * ((op.hp || 100) / (op.maxHp || 100)), 4);

          ctx.fillStyle = "#ffffff";
          ctx.shadowBlur = 4;
          ctx.shadowColor = "#000000";
          ctx.font = "bold 11px Inter, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(`${op.username} (Lvl ${op.level || 1})`, opx, opy - 38);
          ctx.restore();
        }
      });

      // Draw Player Hero (pinned to center representing camera target)
      ctx.save();
      ctx.translate(screenCenterX, screenCenterY);

      ctx.lineWidth = 2;
      if (player.charClass === "mag") {
        ctx.strokeStyle = "rgba(51,204,255,0.4)";
        ctx.beginPath();
        ctx.arc(0, 0, player.radius + 6 + Math.sin(Date.now() * 0.01) * 2, 0, Math.PI * 2);
        ctx.stroke();
      } else if (player.charClass === "wojownik") {
        ctx.strokeStyle = "rgba(255,51,51,0.4)";
        ctx.beginPath();
        ctx.arc(0, 0, player.radius + 6 + Math.cos(Date.now() * 0.01) * 2, 0, Math.PI * 2);
        ctx.stroke();
      } else if (player.charClass === "lucznik") {
        ctx.strokeStyle = "rgba(46,204,113,0.4)";
        ctx.beginPath();
        ctx.arc(0, 0, player.radius + 5, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.rotate(player.angle);

      ctx.beginPath();
      ctx.arc(0, 0, player.radius, 0, Math.PI * 2);
      if (player.charClass === "mag") ctx.fillStyle = "#00d2ff";
      else if (player.charClass === "wojownik") ctx.fillStyle = "#ff3333";
      else if (player.charClass === "lucznik") ctx.fillStyle = "#2ecc71";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 3;
      ctx.stroke();

      // Show specific weaponry models dynamically
      if (player.charClass === "mag") {
        ctx.fillStyle = "#8e44ad";
        ctx.fillRect(8, -4, player.radius + 10, 6);
        ctx.fillStyle = "#33ccff";
        ctx.beginPath();
        ctx.arc(player.radius + 12, -1, 5, 0, Math.PI * 2);
        ctx.fill();
      } else if (player.charClass === "wojownik") {
        ctx.fillStyle = "#7f8c8d";
        ctx.fillRect(5, -3, player.radius + 20, 6);
        ctx.fillStyle = "#f1c40f";
        ctx.fillRect(5, -5, 3, 10);
      } else if (player.charClass === "lucznik") {
        ctx.strokeStyle = "#d35400";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(player.radius - 2, 0, 14, -Math.PI / 2, Math.PI / 2);
        ctx.stroke();
        ctx.strokeStyle = "#eee";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(player.radius - 2, -14);
        ctx.lineTo(player.radius - 2, 14);
        ctx.stroke();
      }

      ctx.restore();

      // Ambient time overlay lighting
      let ambientIntensity = 0;
      if (gameTime < 400 || gameTime > 2000) ambientIntensity = 0.72;
      else if (gameTime >= 400 && gameTime < 700) {
        ambientIntensity = 0.72 - ((gameTime - 400) / 300) * 0.72;
      } else if (gameTime >= 1700 && gameTime <= 2000) {
        ambientIntensity = ((gameTime - 1700) / 300) * 0.72;
      }
      if (currentWeather === "fog") ambientIntensity = Math.max(ambientIntensity, 0.45);

      if (ambientIntensity > 0 && thunderFlash <= 0) {
        ctx.save();
        const lightGrad = ctx.createRadialGradient(screenCenterX, screenCenterY, 30, screenCenterX, screenCenterY, 180);
        lightGrad.addColorStop(0, "rgba(0, 0, 0, 0)");
        lightGrad.addColorStop(1, `rgba(10, 15, 30, ${ambientIntensity})`);
        ctx.fillStyle = lightGrad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }

      if (thunderFlash > 0) {
        ctx.fillStyle = `rgba(255, 255, 255, ${thunderFlash * 0.12})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      // Render weather elements overlays
      ctx.save();
      particles.forEach((p) => {
        if (p.type === "rain") {
          ctx.strokeStyle = "rgba(174, 214, 241, 0.52)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + 1, p.y + p.len);
          ctx.stroke();
        } else if (p.type === "snow") {
          ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.len / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      });
      ctx.restore();

      // Render joysticks
      if (joystick.active) {
        ctx.beginPath();
        ctx.arc(joystick.startX, joystick.startY, joystick.maxRadius, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
        ctx.lineWidth = 2.5;
        ctx.stroke();

        const dx = joystick.currentX - joystick.startX;
        const dy = joystick.currentY - joystick.startY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        let knobX = joystick.currentX;
        let knobY = joystick.currentY;

        if (dist > joystick.maxRadius) {
          const angle = Math.atan2(dy, dx);
          knobX = joystick.startX + Math.cos(angle) * joystick.maxRadius;
          knobY = joystick.startY + Math.sin(angle) * joystick.maxRadius;
        }

        ctx.beginPath();
        ctx.arc(knobX, knobY, 26, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0, 255, 204, 0.55)";
        ctx.fill();
        ctx.stroke();
      }

      // Render minimap
      ctx.save();
      if (isFullScreenMinimapRef.current) {
        // Full screen map drawing covering entire dimensions
        const cellScale = Math.min((canvas.width * 0.76) / mapSettingsRef.current.width, (canvas.height * 0.76) / mapSettingsRef.current.height);
        const totalW = mapSettingsRef.current.width * cellScale;
        const totalH = mapSettingsRef.current.height * cellScale;
        const offsetLeft = (canvas.width - totalW) / 2;
        const offsetTop = (canvas.height - totalH) / 2;

        // Dark background blur container
        ctx.fillStyle = "rgba(11, 19, 36, 0.94)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Map panel box
        ctx.fillStyle = "rgba(16, 24, 48, 0.95)";
        ctx.fillRect(offsetLeft - 24, offsetTop - 24, totalW + 48, totalH + 48);
        ctx.strokeStyle = "rgba(0, 255, 204, 0.45)";
        ctx.lineWidth = 3;
        ctx.strokeRect(offsetLeft - 24, offsetTop - 24, totalW + 48, totalH + 48);

        // Draw entire map cells grid representation
        for (let y = 0; y < mapSettingsRef.current.height; y++) {
          for (let x = 0; x < mapSettingsRef.current.width; x++) {
            const customKey = `${x},${y}`;
            const currentMapTile =
              mapSettingsRef.current.tiles[customKey] ||
              getNoiseTileAt(x, y, mapSettingsRef.current.width, mapSettingsRef.current.height);

            let tileColor = "#111";
            if (currentMapTile === "WATER") tileColor = "#2980b9";
            else if (currentMapTile === "GRASS") tileColor = "#27ae60";
            else if (currentMapTile === "FOREST") tileColor = "#1e8449";
            else if (currentMapTile === "RAINFOREST") tileColor = "#145a32";
            else if (currentMapTile === "MOUNTAIN") tileColor = "#7f8c8d";
            else if (currentMapTile === "DESERT") tileColor = "#f1c40f";

            ctx.fillStyle = tileColor;
            ctx.fillRect(offsetLeft + x * cellScale, offsetTop + y * cellScale, cellScale - 0.4, cellScale - 0.4);
          }
        }

        // Draw Spawns markers on full-screen overview map
        mapSettingsRef.current.spawns.forEach((s) => {
          const sx = s.x * cellScale;
          const sy = s.y * cellScale;
          ctx.beginPath();
          ctx.arc(offsetLeft + sx + cellScale/2, offsetTop + sy + cellScale/2, 5, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(139, 92, 246, 0.85)";
          ctx.fill();
        });

        // Draw enemies
        enemies.forEach((e) => {
          const ex = (e.worldX / TILE_SIZE) * cellScale;
          const ey = (e.worldY / TILE_SIZE) * cellScale;
          ctx.beginPath();
          ctx.arc(offsetLeft + ex, offsetTop + ey, e.type === "boss" ? 6.5 : 3.5, 0, Math.PI * 2);
          ctx.fillStyle = e.type === "boss" ? "#e74c3c" : "#e67e22";
          ctx.fill();
        });

        // Draw peaceful animals
        animals.forEach((a) => {
          const ax = (a.worldX / TILE_SIZE) * cellScale;
          const ay = (a.worldY / TILE_SIZE) * cellScale;
          ctx.beginPath();
          ctx.arc(offsetLeft + ax, offsetTop + ay, 2.8, 0, Math.PI * 2);
          ctx.fillStyle = "#ff82ff";
          ctx.fill();
        });

        // Draw other active online players
        Object.keys(otherPlayers).forEach((pName) => {
          const op = otherPlayers[pName];
          if (!op) return;
          const opx = (op.worldX / TILE_SIZE) * cellScale;
          const opy = (op.worldY / TILE_SIZE) * cellScale;
          ctx.beginPath();
          ctx.arc(offsetLeft + opx, offsetTop + opy, 5, 0, Math.PI * 2);
          ctx.fillStyle = "#00d2ff";
          ctx.fill();

          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 9px Inter, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(op.username, offsetLeft + opx, offsetTop + opy - 6);
        });

        // Draw current local player
        const lpx = (player.worldX / TILE_SIZE) * cellScale;
        const lpy = (player.worldY / TILE_SIZE) * cellScale;
        ctx.beginPath();
        const curSize = 6.2 + Math.sin(Date.now() * 0.01) * 1.8;
        ctx.arc(offsetLeft + lpx, offsetTop + lpy, curSize, 0, Math.PI * 2);
        ctx.fillStyle = "#2ecc71";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Label layout indicators
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 15px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("PEŁNOEKRANOWA MINIMAPA ŚWIATA", canvas.width / 2, offsetTop - 38);

        ctx.font = "normal 12px Inter, sans-serif";
        ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
        ctx.fillText("Naciśnij [M] lub dotknij ikony minimapy z boku, aby powrócić do gry", canvas.width / 2, canvas.height - 24);

        // Color representations indexes help box
        ctx.fillStyle = "rgba(20, 30, 50, 0.7)";
        ctx.fillRect(20, 20, 180, 150);
        ctx.strokeStyle = "rgba(0, 255, 204, 0.25)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(20, 20, 180, 150);

        ctx.font = "bold 10px monospace";
        ctx.textAlign = "left";
        ctx.fillStyle = "#2ecc7绿"; // Use nice light green label text representation
        ctx.fillStyle = "#2ecc71"; ctx.fillText("● TY (ZIELONY)", 35, 42);
        ctx.fillStyle = "#00d2ff"; ctx.fillText("● GRACZE (NIEBIESKI)", 35, 62);
        ctx.fillStyle = "#e74c3c"; ctx.fillText("● POTWORY (CZERWONY)", 35, 82);
        ctx.fillStyle = "#ff82ff"; ctx.fillText("● ZWIERZĘTA (RÓŻ)", 35, 102);
        ctx.fillStyle = "#rgba(139, 92, 246, 0.95)";
        ctx.fillStyle = "#8b5cf6"; ctx.fillText("● SPAWNPUNKTY (FIOLET)", 35, 122);
        ctx.fillStyle = "#ffffff"; ctx.fillText(`ROZMIAR MAPY: ${mapSettingsRef.current.width}x${mapSettingsRef.current.height}`, 35, 150);
      } else {
        const miniRadius = 65;
        const miniCenterX = canvas.width - miniRadius - 20;
        const miniCenterY = canvas.height - miniRadius - 20;

        ctx.beginPath();
        ctx.arc(miniCenterX, miniCenterY, miniRadius, 0, Math.PI * 2);
        ctx.clip();

        ctx.fillStyle = "#040608";
        ctx.fillRect(miniCenterX - miniRadius, miniCenterY - miniRadius, miniRadius * 2, miniRadius * 2);

        // Map drawing scale config
        const scaleFactor = 8.0;

        // Draw terrain cells within range in real-time
        const pxTileFracX = (player.worldX / TILE_SIZE);
        const pxTileFracY = (player.worldY / TILE_SIZE);
        const tileDistLimit = Math.ceil(miniRadius / (TILE_SIZE / scaleFactor)) + 2;

        for (let dy = -tileDistLimit; dy <= tileDistLimit; dy++) {
          for (let dx = -tileDistLimit; dx <= tileDistLimit; dx++) {
            const tileX = Math.floor(pxTileFracX) + dx;
            const tileY = Math.floor(pxTileFracY) + dy;
            
            if (tileX >= 0 && tileX < mapSettingsRef.current.width && tileY >= 0 && tileY < mapSettingsRef.current.height) {
              const customKey = `${tileX},${tileY}`;
              const tileType = mapSettingsRef.current.tiles[customKey] ||
                getNoiseTileAt(tileX, tileY, mapSettingsRef.current.width, mapSettingsRef.current.height);

              let tileColor = "#111";
              if (tileType === "WATER") tileColor = "#2980b9";
              else if (tileType === "GRASS") tileColor = "#27ae60";
              else if (tileType === "FOREST") tileColor = "#1e8449";
              else if (tileType === "RAINFOREST") tileColor = "#145a32";
              else if (tileType === "MOUNTAIN") tileColor = "#7f8c8d";
              else if (tileType === "DESERT") tileColor = "#f1c40f";

              const mdx = (tileX * TILE_SIZE + 16 - player.worldX) / scaleFactor;
              const mdy = (tileY * TILE_SIZE + 16 - player.worldY) / scaleFactor;

              const size = TILE_SIZE / scaleFactor;
              ctx.fillStyle = tileColor;
              ctx.fillRect(miniCenterX + mdx - size/2, miniCenterY + mdy - size/2, size + 0.5, size + 0.5);
            }
          }
        }

        // Draw other active players on small minimap
        Object.keys(otherPlayers).forEach((pName) => {
          const op = otherPlayers[pName];
          if (!op) return;
          const mdx = (op.worldX - player.worldX) / scaleFactor;
          const mdy = (op.worldY - player.worldY) / scaleFactor;
          if (mdx * mdx + mdy * mdy < miniRadius * miniRadius) {
            ctx.beginPath();
            ctx.arc(miniCenterX + mdx, miniCenterY + mdy, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = "#00d2ff";
            ctx.fill();
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        });

        // Draw enemies on small minimap
        enemies.forEach((e) => {
          const mdx = (e.worldX - player.worldX) / scaleFactor;
          const mdy = (e.worldY - player.worldY) / scaleFactor;
          if (mdx * mdx + mdy * mdy < miniRadius * miniRadius) {
            ctx.beginPath();
            ctx.arc(miniCenterX + mdx, miniCenterY + mdy, e.type === "boss" ? 5 : 3, 0, Math.PI * 2);
            ctx.fillStyle = e.type === "boss" ? "#df00ff" : "#ff3333";
            ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,0.5)";
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        });

        // Draw animals/wildlife on small minimap
        animals.forEach((a) => {
          const mdx = (a.worldX - player.worldX) / scaleFactor;
          const mdy = (a.worldY - player.worldY) / scaleFactor;
          if (mdx * mdx + mdy * mdy < miniRadius * miniRadius) {
            ctx.beginPath();
            ctx.arc(miniCenterX + mdx, miniCenterY + mdy, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = "#ff82ff";
            ctx.fill();
          }
        });

        // Draw current player green indicator in center of small radar
        ctx.beginPath();
        ctx.arc(miniCenterX, miniCenterY, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "#2ecc71";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.restore();

      if (!isFullScreenMinimapRef.current) {
        const miniRadius = 65;
        const miniCenterX = canvas.width - miniRadius - 20;
        const miniCenterY = canvas.height - miniRadius - 20;
        ctx.beginPath();
        ctx.arc(miniCenterX, miniCenterY, miniRadius, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0, 255, 204, 0.35)";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    };

    // Spawn classic & ranger/stalker mobs continuously at admin defined amounts!
    const spawnGameEnemy = () => {
      if (!isRunning || chatOverlayActive() || enemies.length >= mapSettingsRef.current.maxMonstersCount) return;

      const angle = Math.random() * Math.PI * 2;
      const distance = Math.max(canvas.width, canvas.height) / 2 + 180;
      const ex = player.worldX + Math.cos(angle) * distance;
      const ey = player.worldY + Math.sin(angle) * distance;

      // Spawn Boss periodically
      if (statsRef.current.score > 0 && statsRef.current.score % 15 === 0 && !enemies.some((e) => e.type === "boss")) {
        enemies.push({
          type: "boss",
          name: "SIERADZKI NISZCZYCIEL",
          worldX: ex,
          worldY: ey,
          radius: 36,
          speed: 2.1,
          hp: 950,
          maxHp: 950,
          xpReward: 250,
          damage: 2.2,
          state: "calm",
          alertProgress: 0,
          shakeX: 0,
          shakeY: 0,
          visionRadius: 400,
          loseTargetRadius: 700,
          walkTimer: 0,
          targetWalkX: ex,
          targetWalkY: ey,
          isWalking: false,
          bossTimer: 0,
          bossActionState: "none",
          chargeVx: 0,
          chargeVy: 0,
          aiSeed: Math.random() * 100
        });
        return;
      }

      // Check configured custom spawnpoints from Admin settings!
      // If spawns are configured, we randomly choose to spawn off one of those spawn positions or spawn procedurally!
      let spawnX = ex;
      let spawnY = ey;
      let forcedType: string | null = null;

      if (mapSettingsRef.current.spawns.length > 0 && Math.random() < 0.6) {
        const randSpawn = mapSettingsRef.current.spawns[Math.floor(Math.random() * mapSettingsRef.current.spawns.length)];
        // Convert tile coordinate to world coordinate
        spawnX = randSpawn.x * TILE_SIZE + 32;
        spawnY = randSpawn.y * TILE_SIZE + 32;
        forcedType = randSpawn.monsterType;
      }

      const typesPool = ["classic"];
      if (statsRef.current.score >= 3) typesPool.push("runner");
      if (statsRef.current.score >= 6) typesPool.push("ranger", "stalker");
      if (statsRef.current.score >= 10) typesPool.push("tank", "shaman");

      const chosenType = forcedType || typesPool[Math.floor(Math.random() * typesPool.length)];

      const enemyData = {
        type: chosenType,
        worldX: spawnX,
        worldY: spawnY,
        state: "calm",
        alertProgress: 0,
        shakeX: 0,
        shakeY: 0,
        walkTimer: Math.random() * 120,
        targetWalkX: spawnX,
        targetWalkY: spawnY,
        isWalking: false,
        aiSeed: Math.random() * 500,
        dynamicTimer: 0,
        rageMode: 1.0,
        radius: 16,
        speed: 2.4,
        hp: 120,
        maxHp: 120,
        xpReward: 32,
        color: "#aa3333",
        agroColor: "#ff1111",
        visionRadius: 260,
        loseTargetRadius: 450,
        damage: 0.65,
        shootCooldown: 0,
        teleportCooldown: 0,
        healCooldown: 0
      };

      if (chosenType === "runner") {
        Object.assign(enemyData, { radius: 14, speed: 4.3, hp: 80, maxHp: 80, xpReward: 40, color: "#ccb11a", agroColor: "#ffff00", visionRadius: 200, loseTargetRadius: 400, damage: 0.5 });
      } else if (chosenType === "ranger") {
        Object.assign(enemyData, { radius: 16, speed: 2.2, hp: 105, maxHp: 105, xpReward: 50, color: "#8e44ad", agroColor: "#d2527f", visionRadius: 310, loseTargetRadius: 500, damage: 0.4 });
      } else if (chosenType === "tank") {
        Object.assign(enemyData, { radius: 25, speed: 1.3, hp: 350, maxHp: 350, xpReward: 90, color: "#27ae60", agroColor: "#2ecc71", visionRadius: 230, loseTargetRadius: 400, damage: 1.35 });
      } else if (chosenType === "stalker") {
        Object.assign(enemyData, { radius: 15, speed: 2.8, hp: 100, maxHp: 100, xpReward: 55, color: "#556270", agroColor: "#4ecdc4", visionRadius: 280, loseTargetRadius: 420, damage: 0.72 });
      } else if (chosenType === "shaman") {
        Object.assign(enemyData, { radius: 17, speed: 1.9, hp: 140, maxHp: 140, xpReward: 70, color: "#e67e22", agroColor: "#f1c40f", visionRadius: 280, loseTargetRadius: 440, damage: 0.3 });
      }

      enemies.push(enemyData);
    };

    const spawnWildAnimal = () => {
      if (!isRunning || chatOverlayActive() || animals.length >= 20) return;

      const angle = Math.random() * Math.PI * 2;
      const distance = Math.max(canvas.width, canvas.height) / 2 + 200;
      const ax = player.worldX + Math.cos(angle) * distance;
      const ay = player.worldY + Math.sin(angle) * distance;

      const behaviors = ["scared", "aggressive", "flying"];
      const bOption = behaviors[Math.floor(Math.random() * behaviors.length)];

      const animalData = {
        behavior: bOption,
        worldX: ax,
        worldY: ay,
        hp: 60,
        maxHp: 60,
        vx: 0,
        vy: 0,
        name: "Wildlife",
        radius: 12,
        speed: 3.5,
        color: "#d7ccc8",
        damage: 0.4,
        vision: 180,
        heightOffset: 40
      };

      if (bOption === "scared") {
        const scaredNames = ["Zając", "Jeleń", "Renifer"];
        Object.assign(animalData, { name: scaredNames[Math.floor(Math.random() * scaredNames.length)], radius: 13, speed: 3.6, color: "#d7ccc8" });
      } else if (bOption === "aggressive") {
        const violentNames = ["Wilk", "Hiena", "Niedźwiedź"];
        const nOption = violentNames[Math.floor(Math.random() * violentNames.length)];
        if (nOption === "Niedźwiedź") {
          Object.assign(animalData, { name: nOption, radius: 24, speed: 1.9, color: "#5d4037", hp: 180, maxHp: 180, damage: 1.25, vision: 210 });
        } else {
          Object.assign(animalData, { name: nOption, radius: 14, speed: 3.1, color: "#78909c", damage: 0.55, vision: 190 });
        }
      } else if (bOption === "flying") {
        const isNight = gameTime < 400 || gameTime > 2000;
        Object.assign(animalData, { name: isNight ? "Nietoperz" : "Ptak", radius: 10, speed: 2.6, color: isNight ? "#37474f" : "#64b5f6" });
      }

      animals.push(animalData);
    };

    const chatOverlayActive = () => {
      return document.getElementById("chatOverlay")?.style.display === "flex";
    };

    // Loops schedulers
    const enemySpawner = setInterval(spawnGameEnemy, 1000);
    const animalSpawner = setInterval(spawnWildAnimal, 2000);

    // Frame trigger
    const tick = () => {
      if (!isRunning) return;
      if (!chatOverlayActive()) {
        updateGameElements();
      }
      renderWorkspace();
      animFrameId = requestAnimationFrame(tick);
    };
    animFrameId = requestAnimationFrame(tick);

    // Cleanup callbacks
    return () => {
      isRunning = false;
      cancelAnimationFrame(animFrameId);
      window.removeEventListener("resize", resizeCanvas);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      clearInterval(enemySpawner);
      clearInterval(animalSpawner);

      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
    };
  }, [charClass, mapSettings, isAdminActive, editorTool, selectedBiome, selectedSpawnType]);

  return (
    <div className="relative w-full h-full select-none overflow-hidden block">
      {/* Canvas */}
      <canvas ref={canvasRef} className="block w-full h-full touch-none z-0" />

      {/* Visual top bar HUD info of game */}
      <div className="absolute top-4 left-4 z-10 bg-[#080A0E]/95 border border-white/5 rounded-xl p-4 min-w-[240px] shadow-2xl space-y-3 font-mono pointer-events-none md:pointer-events-auto select-none">
        <div className="flex justify-between items-center text-xs border-b border-white/5 pb-2">
          <span className="text-white font-bold tracking-wider uppercase">KONTRIUM RPG HUD</span>
          <span className="bg-blue-600/10 border border-blue-500/20 text-blue-400 font-bold px-1.5 py-0.5 rounded text-[9px] uppercase">
            Klasa: {charClass.toUpperCase()}
          </span>
        </div>

        {/* Level metrics */}
        <div className="flex justify-between items-center text-xs text-slate-300 uppercase">
          <span className="text-slate-500 text-[10px] uppercase font-bold tracking-widest">Poziom:</span>
          <span className="text-blue-400 font-bold">{playerLvl}</span>
        </div>

        {/* HP bar container */}
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-slate-500 uppercase tracking-widest font-bold">
            <span>Punkty Zdrowia</span>
            <span className="text-red-400 font-bold">
              {Math.ceil(playerHp)}/{playerMaxHp}
            </span>
          </div>
          <div className="w-full bg-[#050608] border border-white/5 h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-red-500 h-full rounded-full transition-all duration-100"
              style={{ width: `${Math.max(0, (playerHp / playerMaxHp) * 100)}%` }}
            />
          </div>
        </div>

        {/* Mana bar container */}
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-slate-500 uppercase tracking-widest font-bold">
            <span>MOC_MANA</span>
            <span className="text-blue-400 font-bold">
              {Math.ceil(playerMana)}/{playerMaxMana}
            </span>
          </div>
          <div className="w-full bg-[#050608] border border-white/5 h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-blue-500 h-full rounded-full transition-all duration-75"
              style={{ width: `${Math.max(0, (playerMana / playerMaxMana) * 100)}%` }}
            />
          </div>
        </div>

        {/* Stamina bar container */}
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-slate-500 uppercase tracking-widest font-bold">
            <span>STAMINA (BIEG)</span>
            <span className="text-amber-500 font-bold">
              {Math.round(playerStamina)}/{playerMaxStamina}
            </span>
          </div>
          <div className="w-full bg-[#050608] border border-white/5 h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-amber-500 h-full rounded-full transition-all duration-75"
              style={{ width: `${Math.max(0, (playerStamina / playerMaxStamina) * 100)}%` }}
            />
          </div>
        </div>

        {/* XP meter bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-slate-500 uppercase tracking-widest font-bold">
            <span>KONTRIUM_XP</span>
            <span className="text-emerald-400 font-bold">
              {playerXp}/{playerXpNeeded}
            </span>
          </div>
          <div className="w-full bg-[#050608] border border-white/5 h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-emerald-500 h-full rounded-full transition-all"
              style={{ width: `${Math.min(100, (playerXp / playerXpNeeded) * 100)}%` }}
            />
          </div>
        </div>

        {/* Stat Upgrade Panel */}
        <div className="border-t border-white/5 pt-3 space-y-2.5">
          <div className="flex justify-between items-center text-xs text-slate-400 uppercase font-bold tracking-widest">
            <span>Rozwój Statystyk</span>
            {statPoints > 0 ? (
              <span className="bg-amber-500 text-black text-[9px] font-black px-1.5 py-0.5 rounded animate-pulse">
                +{statPoints} PKT
              </span>
            ) : (
              <span className="text-[9px] text-slate-600">0 PKT</span>
            )}
          </div>
          
          <div className="grid grid-cols-1 gap-1.5 text-xs">
            {/* Strength */}
            <div className="flex justify-between items-center bg-white/[0.02] border border-white/[0.03] rounded-lg px-2 py-1">
              <span className="text-slate-400 text-[10px] font-bold">SIŁA (DMG)</span>
              <div className="flex items-center gap-1.5 font-bold">
                <span className="text-red-400">{statStrength}</span>
                {statPoints > 0 ? (
                  <button
                    onClick={() => allocateStatRef.current?.("strength")}
                    className="w-5 h-5 rounded bg-red-500/20 hover:bg-red-500 text-red-300 hover:text-white flex items-center justify-center font-bold text-xs transition-colors cursor-pointer border border-red-500/30"
                  >
                    +
                  </button>
                ) : null}
              </div>
            </div>

            {/* Energy */}
            <div className="flex justify-between items-center bg-white/[0.02] border border-white/[0.03] rounded-lg px-2 py-1">
              <span className="text-slate-400 text-[10px] font-bold">ENERGIA (MANA)</span>
              <div className="flex items-center gap-1.5 font-bold">
                <span className="text-blue-400">{statEnergy}</span>
                {statPoints > 0 ? (
                  <button
                    onClick={() => allocateStatRef.current?.("energy")}
                    className="w-5 h-5 rounded bg-blue-500/20 hover:bg-blue-500 text-blue-300 hover:text-white flex items-center justify-center font-bold text-xs transition-colors cursor-pointer border border-blue-500/30"
                  >
                    +
                  </button>
                ) : null}
              </div>
            </div>

            {/* Life */}
            <div className="flex justify-between items-center bg-white/[0.02] border border-white/[0.03] rounded-lg px-2 py-1">
              <span className="text-slate-400 text-[10px] font-bold">ŻYCIE (HP)</span>
              <div className="flex items-center gap-1.5 font-bold">
                <span className="text-emerald-400">{statLife}</span>
                {statPoints > 0 ? (
                  <button
                    onClick={() => allocateStatRef.current?.("life")}
                    className="w-5 h-5 rounded bg-emerald-500/20 hover:bg-emerald-500 text-emerald-300 hover:text-white flex items-center justify-center font-bold text-xs transition-colors cursor-pointer border border-emerald-500/30"
                  >
                    +
                  </button>
                ) : null}
              </div>
            </div>

            {/* Stamina */}
            <div className="flex justify-between items-center bg-white/[0.02] border border-white/[0.03] rounded-lg px-2 py-1">
              <span className="text-slate-400 text-[10px] font-bold">STAMINA (BIEG)</span>
              <div className="flex items-center gap-1.5 font-bold">
                <span className="text-amber-400">{statStaminaStat}</span>
                {statPoints > 0 ? (
                  <button
                    onClick={() => allocateStatRef.current?.("stamina")}
                    className="w-5 h-5 rounded bg-amber-500/20 hover:bg-amber-500 text-amber-300 hover:text-white flex items-center justify-center font-bold text-xs transition-colors cursor-pointer border border-amber-500/30"
                  >
                    +
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* Weather type and custom parameters indicators */}
        <div className="flex justify-between items-center text-[10px] text-slate-500 pt-1 border-t border-white/5 uppercase font-bold tracking-widest">
          <span>POGODA:</span>
          <span className="font-bold text-amber-500 tracking-wider font-mono">{currentWeather}</span>
        </div>

        <div className="flex justify-between items-center text-[10px] text-slate-500 uppercase font-bold tracking-widest">
          <span>POKONANI WROGOWIE:</span>
          <span className="font-bold text-white">{score}</span>
        </div>
      </div>

      {/* Real-time Boss HUD */}
      {bossUiActive && (
        <div className="absolute top-5 left-1/2 -translate-x-1/2 w-[50%] min-w-[280px] z-10 bg-black/90 border-2 border-red-500/80 rounded-xl p-3.5 text-center font-mono shadow-[0_0_20px_rgba(239,68,68,0.3)] animate-pulse select-none pointer-events-none">
          <div className="text-red-500 font-black tracking-wider text-xs uppercase mb-1.5">
            Mityczny Boss: SIERADZKI NISZCZYCIEL Swarms
          </div>
          <div className="w-full bg-gray-900 border border-red-500/30 h-3 rounded-md overflow-hidden">
            <div className="bg-gradient-to-r from-red-600 to-amber-500 h-full" style={{ width: `${bossHpPercentage}%` }} />
          </div>
        </div>
      )}

      {/* Editor Active Brush Hint Overlay */}
      {isAdminActive && editorTool !== "none" && (
        <div className="absolute top-22 left-4 z-10 bg-amber-400/95 border border-amber-500 text-black font-semibold rounded-lg py-1.5 px-3 shadow text-[10px] flex items-center gap-1.5 pointer-events-none uppercase">
          <ShieldCheck className="w-4 h-4" />
          <span>
            {editorTool === "paint" ? `Tryb rysowania: ${selectedBiome}` : "KLIKNIJ ABY POSTAWIĆ SPAWNPOINT"}
          </span>
        </div>
      )}

      {/* Dynamic Class Action bar with Touch Skill Slots & Dodge Action Button */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 bg-[#080A0E]/95 border border-white/5 backdrop-blur-md p-3.5 rounded-2xl shadow-[0_15px_35px_rgba(0,0,0,0.85)] max-w-[95vw] pointer-events-auto select-none">
        
        {/* Ability Slot 1 (Unlocked at lvl 5) */}
        {(() => {
          const locked = playerLvl < 5;
          const active = selectedSpell === 1;
          const cd = spell1Cooldown;
          const name = charClass === "mag" ? "Frost Nova (Lvl 5)" : charClass === "wojownik" ? "Ground Slam (Lvl 5)" : "Poison Shot (Lvl 5)";
          const desc = charClass === "mag" ? "Zamraża wrogów wokół" : charClass === "wojownik" ? " Fala uderzeniowa" : "Zatruta strzała";
          const manaCost = charClass === "mag" ? 30 : charClass === "wojownik" ? 15 : 20;

          return (
            <button
              onClick={() => {
                if (locked) return;
                if (active) {
                  castSpellRef.current?.(1);
                } else {
                  setSelectedSpell(1);
                }
              }}
              className={`relative flex flex-col items-center justify-center w-15 h-15 rounded-xl border transition-all cursor-pointer select-none overflow-hidden
                ${locked ? 'bg-slate-900/40 border-slate-800 text-slate-600 cursor-not-allowed' :
                  active ? 'bg-cyan-500/10 border-cyan-400 text-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.25)]' :
                  'bg-slate-950/70 border-white/5 text-slate-300 hover:bg-slate-900 hover:border-slate-700'
                }`}
              title={`${name} - Koszt: ${manaCost} Mana\nOpis: ${desc}`}
            >
              {locked ? (
                <>
                  <Lock className="w-4 h-4 opacity-60 mb-0.5" />
                  <span className="text-[8px] font-bold text-slate-500 uppercase">Lvl 5</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mb-0.5 text-cyan-400 animate-pulse" />
                  <span className="text-[8px] font-bold uppercase tracking-wider">SKILL 1</span>
                  <span className="text-[7px] font-mono text-slate-400 opacity-80 mt-0.5">{manaCost} M</span>
                  
                  {/* Cooldown Layer Overlay */}
                  {cd > 0 && (
                    <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-[1px] flex items-center justify-center font-bold text-xs text-rose-400 font-mono">
                      {cd}s
                    </div>
                  )}
                </>
              )}
            </button>
          );
        })()}

        {/* Ability Slot 2 (Unlocked at lvl 10) */}
        {(() => {
          const locked = playerLvl < 10;
          const active = selectedSpell === 2;
          const cd = spell2Cooldown;
          const name = charClass === "mag" ? "Arcane Beam (Lvl 10)" : charClass === "wojownik" ? "Blade Whirl (Lvl 10)" : "Hurricane (Lvl 10)";
          const desc = charClass === "mag" ? "Laser energetyczny" : charClass === "wojownik" ? "Wirujące ostrza" : "Huraganowa odpychająca strzała";
          const manaCost = charClass === "mag" ? 50 : charClass === "wojownik" ? 30 : 35;

          return (
            <button
              onClick={() => {
                if (locked) return;
                if (active) {
                  castSpellRef.current?.(2);
                } else {
                  setSelectedSpell(2);
                }
              }}
              className={`relative flex flex-col items-center justify-center w-15 h-15 rounded-xl border transition-all cursor-pointer select-none overflow-hidden
                ${locked ? 'bg-slate-900/40 border-slate-800 text-slate-600 cursor-not-allowed' :
                  active ? 'bg-violet-500/10 border-violet-400 text-violet-400 shadow-[0_0_12px_rgba(167,139,250,0.25)]' :
                  'bg-slate-950/70 border-white/5 text-slate-300 hover:bg-slate-900 hover:border-slate-700'
                }`}
              title={`${name} - Koszt: ${manaCost} Mana\nOpis: ${desc}`}
            >
              {locked ? (
                <>
                  <Lock className="w-4 h-4 opacity-60 mb-0.5" />
                  <span className="text-[8px] font-bold text-slate-500 uppercase">Lvl 10</span>
                </>
              ) : (
                <>
                  <Flame className="w-4 h-4 mb-0.5 text-violet-400" />
                  <span className="text-[8px] font-bold uppercase tracking-wider">SKILL 2</span>
                  <span className="text-[7px] font-mono text-slate-400 opacity-80 mt-0.5">{manaCost} M</span>
                  
                  {/* Cooldown Layer Overlay */}
                  {cd > 0 && (
                    <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-[1px] flex items-center justify-center font-bold text-xs text-rose-400 font-mono">
                      {cd}s
                    </div>
                  )}
                </>
              )}
            </button>
          );
        })()}

        {/* Ability Slot 3 - ULTIMATE (Unlocked at lvl 15) */}
        {(() => {
          const locked = playerLvl < 15;
          const active = selectedSpell === 3;
          const cd = spell3Cooldown;
          const name = charClass === "mag" ? "Lava Core (Lvl 15)" : charClass === "wojownik" ? "Lava Explosion (Lvl 15)" : "Windrider (Lvl 15)";
          const desc = charClass === "mag" ? "Mega wulkan magmowy" : charClass === "wojownik" ? "Zatrzęsienie wrzącej lawy" : "Super prędkość";
          const manaCost = charClass === "mag" ? 85 : charClass === "wojownik" ? 60 : 70;

          return (
            <button
              onClick={() => {
                if (locked) return;
                if (active) {
                  castSpellRef.current?.(3);
                } else {
                  setSelectedSpell(3);
                }
              }}
              className={`relative flex flex-col items-center justify-center w-15 h-15 rounded-xl border transition-all cursor-pointer select-none overflow-hidden
                ${locked ? 'bg-slate-900/40 border-slate-800 text-slate-600 cursor-not-allowed' :
                  active ? 'bg-amber-500/10 border-amber-400 text-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.25)]' :
                  'bg-slate-950/70 border-white/5 text-slate-300 hover:bg-slate-900 hover:border-slate-700'
                }`}
              title={`${name} - Koszt: ${manaCost} Mana\nOpis: ${desc}`}
            >
              {locked ? (
                <>
                  <Lock className="w-4 h-4 opacity-60 mb-0.5" />
                  <span className="text-[8px] font-bold text-slate-500 uppercase">Lvl 15</span>
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 mb-0.5 text-amber-400 animate-bounce" />
                  <span className="text-[8px] font-black uppercase tracking-widest text-amber-400">ULTI</span>
                  <span className="text-[7px] font-mono text-slate-400 opacity-80 mt-0.5">{manaCost} M</span>
                  
                  {/* Cooldown Layer Overlay */}
                  {cd > 0 && (
                    <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-[1px] flex items-center justify-center font-bold text-xs text-rose-400 font-mono">
                      {cd}s
                    </div>
                  )}
                </>
              )}
            </button>
          );
        })()}

        {/* Divider bar */}
        <div className="w-[1px] h-8 bg-white/10 mx-1" />

        {/* Touch Dodge / Dash / Unik button (Shift key helper) */}
        {(() => {
          const cd = dashCooldown;
          const active = cd > 0;

          return (
            <button
              onClick={() => {
                triggerDashRef.current?.();
              }}
              className={`relative flex flex-col items-center justify-center w-15 h-15 rounded-xl border transition-all cursor-pointer select-none overflow-hidden
                ${active ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.15)]' :
                  'bg-slate-950/70 border-[#00ffcc]/30 text-[#00ffcc] hover:bg-slate-900 hover:border-[#00ffcc]/70'
                }`}
              title="UNIK / DASH (Skrót [Shift] lub Double-Click)\nDaje niewrażliwość na obrażenia."
            >
              <Wind className="w-4 h-4 mb-0.5 text-[#00ffcc]" />
              <span className="text-[8px] font-black uppercase tracking-wider">UNIK</span>
              <span className="text-[6.5px] font-mono text-slate-400 opacity-80 mt-0.5">SHIFT</span>
              
              {/* Cooldown Layer Overlay */}
              {cd > 0 && (
                <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-[1px] flex items-center justify-center font-bold text-xs text-rose-400 font-mono">
                  {cd}s
                </div>
              )}
            </button>
          );
        })()}

        {/* Fast Running / Szybki bieg toggle button */}
        {(() => {
          return (
            <button
              onClick={() => {
                toggleRunningRef.current?.();
              }}
              className={`relative flex flex-col items-center justify-center w-15 h-15 rounded-xl border transition-all cursor-pointer select-none overflow-hidden
                ${isRunning ? 'bg-amber-500/25 border-amber-400 text-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.25)]' :
                  'bg-slate-950/70 border-white/5 text-slate-400 hover:bg-slate-900 hover:border-slate-700'
                }`}
              title="SZYBKI BIEG (Skrót [R] lub przycisk)\nZwiększa prędkość poruszania się o 50% za pobraniem staminy."
            >
              <Zap className={`w-4 h-4 mb-0.5 ${isRunning ? 'text-amber-400 animate-pulse' : 'text-slate-500'}`} />
              <span className="text-[8px] font-black uppercase tracking-wider">SPRINT</span>
              <span className="text-[6.5px] font-mono text-slate-400 opacity-80 mt-0.5">KLAWISZ R</span>
            </button>
          );
        })()}

      </div>
    </div>
  );
}
