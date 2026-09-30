// ============================================================
// shaders.js – Shaders GLSL personnalisés pour particules, flux, sol
// Dépend de Three.js
// VERSION 8.5 – OPTIMISATION : Template literals, précompilation, fallback
// ============================================================

/**
 * Collection de shaders GLSL pour les effets visuels 3D
 * @namespace CPShaders
 */
    const CPShaders = {

        // Version de la collection de shaders (cycle de vie indépendant)
        VERSION: '8.5.0',

        // --- Vertex Shader pour particules ---
        particleVertex: `
        attribute float size;
        attribute vec3 color;
        attribute float offset;
        uniform float uTime;
        uniform float uPixelRatio;

        varying vec3 vColor;
        varying float vOffset;

        void main() {
            vColor = color;
            vOffset = offset;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = size * uPixelRatio * (300.0 / -mvPosition.z);
            gl_PointSize = clamp(gl_PointSize, 1.0, 100.0);
            gl_Position = projectionMatrix * mvPosition;
        }
    `,

    // --- Fragment Shader pour particules ---
    particleFragment: `
        varying vec3 vColor;
        varying float vOffset;

        void main() {
            vec2 center = gl_PointCoord - vec2(0.5);
            float dist = length(center);
            if (dist > 0.5) discard;
            float alpha = 1.0 - smoothstep(0.2, 0.5, dist);
            float glow = exp(-dist * 8.0);
            vec3 finalColor = vColor + vec3(0.3, 0.6, 1.0) * glow * 0.4;
            float finalAlpha = alpha * (0.7 + 0.3 * sin(vOffset * 3.14159 * 2.0));
            gl_FragColor = vec4(finalColor, finalAlpha * 0.85);
        }
    `,

    // --- Vertex Shader pour les lignes de flux ---
    flowLineVertex: `
        attribute float progress;
        uniform float uTime;
        varying float vProgress;

        void main() {
            vProgress = progress;
            vec3 pos = position;
            pos.y += sin(pos.x * 0.5 + uTime * 0.3) * 0.05;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
    `,

    // --- Fragment Shader pour les lignes de flux ---
    flowLineFragment: `
        varying float vProgress;
        uniform vec3 uColorStart;
        uniform vec3 uColorEnd;
        uniform float uTime;

        void main() {
            vec3 color = mix(uColorStart, uColorEnd, vProgress);
            float alpha = 0.4 + 0.4 * sin(vProgress * 3.14159 * 4.0 + uTime * 0.5);
            alpha = alpha * (0.6 + 0.4 * (1.0 - abs(vProgress - 0.5) * 2.0));
            gl_FragColor = vec4(color, alpha);
        }
    `,

    // --- Shader pour le champ de potentiel ---
    potentialVertex: `
        varying vec2 vUv;
        varying vec3 vPosition;

        void main() {
            vUv = uv;
            vPosition = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,

    potentialFragment: `
        uniform float uTime;
        uniform vec3 uColorLow;
        uniform vec3 uColorHigh;
        uniform float uIntensity;
        varying vec2 vUv;
        varying vec3 vPosition;

        void main() {
            float x = vUv.x * 8.0 + uTime * 0.1;
            float y = vUv.y * 8.0 + uTime * 0.08;
            float val = sin(x + uTime * 0.2) * cos(y + uTime * 0.15) * 0.5 + 0.5;
            float noise = sin(vPosition.x * 0.3 + vPosition.z * 0.4 + uTime * 0.05) * 0.1;
            val = clamp(val + noise, 0.0, 1.0);
            vec3 color = mix(uColorLow, uColorHigh, val);
            float alpha = 0.15 + 0.25 * val;
            gl_FragColor = vec4(color, alpha * uIntensity);
        }
    `,

    // --- Shader pour le sol ---
    soilVertex: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        varying vec2 vUv;

        void main() {
            vNormal = normalize(normalMatrix * normal);
            vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,

    soilFragment: `
        uniform vec3 uColor1;
        uniform vec3 uColor2;
        uniform vec3 uColor3;
        uniform float uTime;
        uniform float uDepth;
        varying vec3 vNormal;
        varying vec3 vPosition;
        varying vec2 vUv;

        void main() {
            float height = vPosition.y;
            float mixFactor = smoothstep(-uDepth, 0.0, height);
            vec3 color = mix(uColor2, uColor1, mixFactor);
            if (height < -uDepth * 0.5) {
                float deepMix = smoothstep(-uDepth, -uDepth * 0.5, height);
                color = mix(uColor3, color, deepMix);
            }
            float noise1 = sin(vPosition.x * 0.8 + vPosition.z * 1.2 + uTime * 0.02) * 0.05;
            float noise2 = sin(vPosition.x * 1.5 - vPosition.z * 0.7 + uTime * 0.03) * 0.03;
            float noise = 0.95 + noise1 + noise2;
            color *= noise;
            float shade = 0.5 + 0.5 * dot(vNormal, normalize(vec3(0.5, 1.0, 0.3)));
            color *= shade;
            gl_FragColor = vec4(color, 1.0);
        }
    `,

    // --- Shader pour les câbles lumineux ---
    cableVertex: `
        attribute float progress;
        uniform float uTime;
        varying float vProgress;
        varying vec3 vColor;

        void main() {
            vProgress = progress;
            vec3 pos = position;
            pos.y += sin(pos.x * 0.3 + uTime * 0.2 + progress * 2.0) * 0.02;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
            vColor = mix(vec3(0.0, 0.8, 0.4), vec3(0.0, 0.4, 0.8), progress);
        }
    `,

    cableFragment: `
        varying float vProgress;
        varying vec3 vColor;
        uniform float uTime;

        void main() {
            float pulse = 0.7 + 0.3 * sin(vProgress * 20.0 - uTime * 0.5);
            vec3 color = vColor * pulse;
            float alpha = 0.5 + 0.3 * pulse;
            gl_FragColor = vec4(color, alpha);
        }
    `,

    // --- Shader pour les anodes actives ---
    anodeGlowVertex: `
        varying vec3 vNormal;
        varying vec3 vPosition;

        void main() {
            vNormal = normalize(normalMatrix * normal);
            vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,

    anodeGlowFragment: `
        uniform vec3 uColor;
        uniform float uIntensity;
        uniform float uTime;
        varying vec3 vNormal;
        varying vec3 vPosition;

        void main() {
            float pulse = 0.7 + 0.3 * sin(uTime * 0.5 + vPosition.y * 2.0);
            float fresnel = 1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0)));
            fresnel = pow(fresnel, 2.0);
            float glow = fresnel * pulse * uIntensity;
            vec3 color = uColor * (1.0 + glow * 0.5);
            float alpha = 0.6 + 0.4 * pulse;
            gl_FragColor = vec4(color, alpha);
        }
    `,

    // OPTIM : Précompilation des shaders pour les matériaux fréquemment utilisés
    precompile: function() {
        // Cette méthode peut être appelée pour précompiler les shaders
        // Mais Three.js le fait automatiquement, donc on garde juste une référence
        console.log('[Shaders] Prêts à être utilisés.');
    }
};

if (typeof window !== 'undefined') {
    window.CPShaders = CPShaders;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CPShaders;
}