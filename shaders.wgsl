// ============================================================
// shaders.wgsl  —  Gem shader with BVH + UI controls
// Lighting matches raytracer.cpp light models:
//   ISO  — uniform hemisphere
//   COS  — cosine (bright zenith, dark horizon)
//   SC2  — 2*sin*cos (bright at 45°, dark at zenith & horizon)
//   RND  — random mottled sky with spotlights
// ============================================================

// -----------------------------------------------------------
// Uniform layout (must match JS writeBuffer offsets exactly):
// -----------------------------------------------------------
struct Uniforms {
    modelMatrix:          mat4x4<f32>,  // 0
    viewMatrix:           mat4x4<f32>,  // 64
    projectionMatrix:     mat4x4<f32>,  // 128
    cameraPosition:       vec3<f32>,    // 192
    clarity:              f32,          // 204
    time:                 f32,          // 208
    ri_d:                 f32,          // 212
    cod:                  f32,          // 216
    lightMode:            f32,          // 220
    stoneColor:           vec3<f32>,    // 224
    graphMode:            f32,          // 236 (0 = normal render, >0.5 = raw graph luminance)
    exitHighlight:        vec3<f32>,    // 240
    exitStrength:         f32,          // 252
    flatShading:          f32,          // 256
    headShadowR:          f32,          // 260
    headShadowG:          f32,          // 264
    headShadowB:          f32,          // 268
    convexFacetMode:      f32,          // 272
};

@group(0) @binding(0) var<uniform>       uniforms:  Uniforms;

struct Tri {
    v0: vec4<f32>,      // xyz = v0, w unused/frosted maybe
    e1: vec4<f32>,      // xyz = v1 - v0
    e2: vec4<f32>,      // xyz = v2 - v0
    normal: vec4<f32>,  // xyz = normal, w = frosted
};
@group(0) @binding(1) var<storage, read> triangles: array<Tri>;

struct BVHNode {
    bmin: vec4<f32>, // xyz = min, w = leftOrTriStart
    bmax: vec4<f32>, // xyz = max, w = triCountOrNegRight
};
@group(0) @binding(2) var<storage, read> bvhNodes: array<BVHNode>;

struct Facet {
    normal: vec4<f32>, // xyz = outward normal, w = plane distance
    data: vec4<f32>,   // x = frosted/material/etc.
};
@group(0) @binding(3) var<storage, read> facets: array<Facet>;

// ─────────────────────────────────────────────────
// Vertex shader
// ─────────────────────────────────────────────────
struct VertexOutput {
    @builtin(position) position:      vec4<f32>,
    @location(0)       worldPosition: vec3<f32>,
    @location(1)       worldNormal:   vec3<f32>,
    @location(2)       localPos:      vec3<f32>,
    @location(3) @interpolate(flat) frosted: f32,
};

@vertex
fn vs_main(@location(0) pos: vec3<f32>, @location(1) norm: vec3<f32>, @location(2) frosted: f32) -> VertexOutput {
    var out: VertexOutput;
    let worldPos      = uniforms.modelMatrix * vec4<f32>(pos, 1.0);
    out.worldPosition = worldPos.xyz;
    out.worldNormal   = normalize((uniforms.modelMatrix * vec4<f32>(norm, 0.0)).xyz);
    out.localPos      = pos;
    out.frosted       = frosted;
    out.position      = uniforms.projectionMatrix * uniforms.viewMatrix * worldPos;
    return out;
}

// ─────────────────────────────────────────────────
// Cauchy dispersion: n(λ) = A + B/λ²
// Returns (ri_r, ri_g, ri_b) for λ = 650, 510, 475 nm in one call,
// hoisting the shared A and B coefficients.
// ─────────────────────────────────────────────────
fn cauchy_ri3(ri_d: f32, cod: f32) -> vec3<f32> {
    let B = cod * 306033.0;
    let A = ri_d - B / (589.3 * 589.3);
    return vec3<f32>(
        A + B / (650.0 * 650.0),  // red   650 nm
        A + B / (510.0 * 510.0),  // green 510 nm
        A + B / (475.0 * 475.0),  // blue  475 nm
    );
}

// ─────────────────────────────────────────────────
// Hash for RND sky — smooth bilinear patch grid
// matching raytracer's npatch=17 random sky array
// ─────────────────────────────────────────────────
fn hash21(p: vec2<f32>) -> f32 {
    var q = fract(p * vec2<f32>(127.1, 311.7));
    q += dot(q, q + 17.43);
    return fract(q.x * q.y);
}

fn rnd_sky(d: vec3<f32>) -> f32 {
    let uv = d.xz * 8.5 + 8.5; // scale to [0,17] patch space
    let i  = floor(uv);
    let f  = fract(uv);
    let a  = hash21(i);
    let b  = hash21(i + vec2<f32>(1.0, 0.0));
    let c  = hash21(i + vec2<f32>(0.0, 1.0));
    let dd = hash21(i + vec2<f32>(1.0, 1.0));
    let sf = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, sf.x), mix(c, dd, sf.x), sf.y);
}

// ─────────────────────────────────────────────────
// Environment sampler
// Implements all four raytracer.cpp light models.
// headshadow angle hardcoded
// cos(20°) ≈ 0.9397
// cos(10°) ≈ 0.9848
// ─────────────────────────────────────────────────
fn sample_env_view(dirView: vec3<f32>) -> vec3<f32> {
    let d    = dirView; // caller guarantees unit length
    let mode = uniforms.lightMode;
    let graph = uniforms.graphMode > 0.5;

    // Head shadow — coloured circle directly above stone (viewer's head)
    var shadowTint = vec3<f32>(1.0);
    if (d.z > 0.9848) {
        if (graph) {
            shadowTint = vec3<f32>(0.0, 0.0, 0.0);
        }
        else {
            shadowTint = vec3<f32>(uniforms.headShadowR, uniforms.headShadowG, uniforms.headShadowB);
        }
    }

    var intensity = 0.0;

    if (mode < 0.5) {
        // ISO: uniform — constant 1.0 above horizon
        // Matches: isoInten += ss * c  where c = 1
        intensity = select(0.0, 1.0, d.z > 0.0);

    } else if (mode < 1.5) {
        // COS: cosine-weighted — bright zenith, dark horizon
        // Matches: cosInten += ss * d  where d = dot(ray, up)
        intensity = max(0.0, d.z);

    } else if (mode < 2.5) {
        // SC2: sin(2θ) = 2·sinθ·cosθ — bright at 45°
        // Matches: sc2Inten += ss * e  where e = 2*sinθ*cosθ
        let sinTheta = sqrt(max(0.0, 1.0 - d.z * d.z));
        intensity = 2.0 * sinTheta * max(0.0, d.z);

    } else {
        // RND: mottled patches + moving spotlights
        // Matches: rndInten bilinear sky + spotlight loop (nspot=20)
        if (d.z > 0.0) {
            intensity = rnd_sky(d) * 0.85;
            // Static spotlights (removed time-varying motion)
            const p1 = vec3<f32>(0.0, 1.0, 0.0);
            const p2 = vec3<f32>(0.5, 0.7, 0.5);
            const p3 = vec3<f32>(-0.57, 0.68, 0.46);
            intensity += pow(max(0.0, dot(d, p1)), 80.0) * 2.5;
            intensity += pow(max(0.0, dot(d, p2)), 80.0) * 1.8;
            intensity += pow(max(0.0, dot(d, p3)), 60.0) * 1.5;
        }
    }

    let envLight = vec3<f32>(intensity) * shadowTint;

    // Stone colour tint — modulates transmitted light so the body colour
    // of coloured gems (ruby, sapphire, emerald) comes through correctly.
    let tint = select(
        vec3<f32>(1.0),
        uniforms.stoneColor,
        !graph,
    );

    // Small white ambient from below (light table / bench lamp)
    // Matches the raytracer's background "leak" colour
    let tableAmbient = select(
        vec3<f32>(0.0),
        vec3<f32>(0.06, 0.06, 0.06) * max(0.0, -d.z + 0.25),
        !graph && mode > 2.5,
    );

    return envLight + tableAmbient;
}

fn sample_env(dirWorld: vec3<f32>) -> vec3<f32> {
    // dirWorld is unit length; viewMatrix is orthogonal so product stays unit length.
    let dView = (uniforms.viewMatrix * vec4<f32>(dirWorld, 0.0)).xyz;
    return sample_env_view(dView);
}

fn aces_tonemap(x: vec3<f32>) -> vec3<f32> {
    const a = 2.51; const b = 0.03; const c = 2.43; const d = 0.59; const e = 0.14;
    return clamp((x*(a*x+b))/(x*(c*x+d)+e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn aces_tonemap_fast(x: vec3<f32>) -> vec3<f32> {
    // Pre-compute common values
    let x2 = x * x;
    let num = (x2 * 2.51 + x * 0.03);
    let den = (x2 * 2.43 + x * 0.59 + 0.14);
    return clamp(num / den, vec3<f32>(0.0), vec3<f32>(1.0));
}

// ─────────────────────────────────────────────────
// Ray–AABB slab test
// ─────────────────────────────────────────────────
fn ray_aabb(ro: vec3<f32>, inv_rd: vec3<f32>,
            bmin: vec3<f32>, bmax: vec3<f32>) -> vec2<f32> {
    let t0   = (bmin - ro) * inv_rd;
    let t1   = (bmax - ro) * inv_rd;
    let tMin = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
    let tMax = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
    return vec2<f32>(tMin, tMax);
}

// ─────────────────────────────────────────────────
// Möller–Trumbore ray–triangle
// ─────────────────────────────────────────────────
fn ray_triangle(ro: vec3<f32>, rd: vec3<f32>, triIdx: i32) -> f32 {
    let tri = triangles[triIdx];

    let v0 = tri.v0.xyz;
    let e1 = tri.e1.xyz;
    let e2 = tri.e2.xyz;

    let h = cross(rd, e2);
    let det = dot(e1, h);

    if (abs(det) < 1e-6) { return -1.0; }

    let inv_det = 1.0 / det;
    let s = ro - v0;
    let u = dot(s, h) * inv_det;

    if (u < 0.0 || u > 1.0) { return -1.0; }

    let q = cross(s, e1);
    let v = dot(rd, q) * inv_det;

    if (v < 0.0 || u + v > 1.0) { return -1.0; }

    let t = dot(e2, q) * inv_det;
    return select(-1.0, t, t >= 1e-4);
}

// ─────────────────────────────────────────────────
// BVH traversal — iterative, explicit stack
// ─────────────────────────────────────────────────
struct HitResult { t: f32, normal: vec3<f32>, frosted: f32 };

fn bvh_intersect(ro: vec3<f32>, rd: vec3<f32>) -> HitResult {
    var result: HitResult;
    result.t       = -1.0;
    result.normal  = vec3<f32>(0.0, 1.0, 0.0);
    result.frosted = 0.0;

    let inv_rd = vec3<f32>(1.0) / rd;
    var tBest = 1e9;
    var bestTri = -1;

    const stackSize = 32;
    var stack: array<i32, stackSize>;
    stack[0] = 0;
    var stackTop = 1;

    while (stackTop > 0) {
        stackTop -= 1;

        let nodeIdx = stack[stackTop];
        let node = bvhNodes[nodeIdx];

        let ab = ray_aabb(ro, inv_rd, node.bmin.xyz, node.bmax.xyz);
        if (ab.y < ab.x || ab.x > tBest) {
            continue;
        }

        let leftOrTriStart = i32(node.bmin.w);
        let triCountOrRight = node.bmax.w;

        if (triCountOrRight > 0.0) {
            let triStart = leftOrTriStart;
            let triCount = i32(triCountOrRight);

            for (var i = 0; i < triCount; i += 1) {
                let triIdx = triStart + i;
                let t = ray_triangle(ro, rd, triIdx);

                if (t > 0.0 && t < tBest) {
                    tBest = t;
                    result.t = t;
                    bestTri = triIdx;
                }
            }
        } else {
            let leftChild = leftOrTriStart;
            let rightChild = i32(-triCountOrRight) - 1;

            let leftNode = bvhNodes[leftChild];
            let rightNode = bvhNodes[rightChild];

            let abL = ray_aabb(ro, inv_rd, leftNode.bmin.xyz, leftNode.bmax.xyz);
            let abR = ray_aabb(ro, inv_rd, rightNode.bmin.xyz, rightNode.bmax.xyz);

            let hitL = abL.y >= abL.x && abL.x <= tBest;
            let hitR = abR.y >= abR.x && abR.x <= tBest;

            if (hitL && hitR && stackTop + 1 < stackSize) {
                if (abL.x <= abR.x) {
                    stack[stackTop] = rightChild;
                    stack[stackTop + 1] = leftChild;
                } else {
                    stack[stackTop] = leftChild;
                    stack[stackTop + 1] = rightChild;
                }
                stackTop += 2;
            } else if (hitL && stackTop < stackSize) {
                stack[stackTop] = leftChild;
                stackTop += 1;
            } else if (hitR && stackTop < stackSize) {
                stack[stackTop] = rightChild;
                stackTop += 1;
            }
        }
    }

    if (bestTri >= 0) {
        let tri = triangles[bestTri];
        result.normal = tri.normal.xyz;
        result.frosted = tri.normal.w;
    }

    return result;
}

fn intersect_convex_facets(ro: vec3<f32>, rd: vec3<f32>) -> HitResult {
    var bestT = 1e9;
    var bestI = -1;
    let facetCount = i32(facets[0].data.w);

    for (var i = 0; i < facetCount; i += 1) {
        let f = facets[i];
        let n = f.normal.xyz;
        let d = f.normal.w;

        // Plane: dot(n, p) + d = 0
        let denom = dot(n, rd);

        // Ignore planes facing away or nearly parallel.
        if (denom > 0) {
            let t = (d - dot(n, ro)) / denom;
            // let t = -(dot(n, ro) + d) / denom;

            if (t > 1e-4 && t < bestT) {
                bestT = t;
                bestI = i;
            }
        }
    }

    var hit: HitResult;
    hit.t = bestT;
    hit.normal = facets[bestI].normal.xyz;
    hit.frosted = facets[bestI].data.x;
    return hit;
}

// ─────────────────────────────────────────────────
// trace_internal return value (per R/G/B channel):
//   light  — brilliance: energy returned toward the viewer
//   window — fraction of throughput that leaked out the pavilion
//            0 = full TIR, 1 = pure window
// ─────────────────────────────────────────────────
struct TraceResult {
    light: vec3<f32>,
    window: vec3<f32>,
    dist: f32,
    zoneDist: vec2<f32>
};

// Merged 3-channel trace: one BVH traversal per bounce shared across R/G/B.
// The green channel drives geometry (navigator ray). R and B deviate only by
// the small dispersion angle, so they hit the same facet — a valid approximation
// for all common gem materials (Δangle < 0.5° even for high-dispersion CZ).
fn trace_internal(rd_r: vec3<f32>, rd_g: vec3<f32>, rd_b: vec3<f32>,
                  origin_in: vec3<f32>, eta: vec3<f32>,
                  mvMatrix: mat4x4<f32>, modelNZ: vec3<f32>) -> TraceResult {
    var r      = rd_r;
    var g      = rd_g;
    var b      = rd_b;
    var origin = origin_in;

    var accumulated = vec3<f32>(0.0);
    var throughput  = vec3<f32>(1.0);
    var windowLeak  = vec3<f32>(0.0);
    var totalDist   = 0.0; // Track cumulative distance
    var zoneDist    = vec2<f32>(0.0); // x = purple(left), y = amber(right)

    for (var bounce = 0; bounce < 10; bounce++) {
        // Single BVH traversal using the green (middle) navigator ray
        // let hit = bvh_intersect(origin, g);
        var hit: HitResult;
        if (uniforms.convexFacetMode > 0.5) {
             hit = intersect_convex_facets(origin, g);
        } else {
             hit = bvh_intersect(origin, g);
        }

        if (hit.t < 0.0) {
            // All channels escaped — sample environment per direction
            // accumulated += throughput * vec3<f32>(
            //     sample_env_view((mvMatrix * vec4<f32>(r, 0.0)).xyz).r,
            //     sample_env_view((mvMatrix * vec4<f32>(g, 0.0)).xyz).g,
            //     sample_env_view((mvMatrix * vec4<f32>(b, 0.0)).xyz).b,
            // );
            let envSample = sample_env_view((mvMatrix * vec4<f32>(g, 0.0)).xyz);
            accumulated += throughput * envSample;
            break;
        }

        // Split this segment distance between purple/amber zones.
        let segEnd = origin + g * hit.t;
        let coord0 = origin.x + origin.z * 0.30;
        let coord1 = segEnd.x + segEnd.z * 0.30;
        var leftFrac = 0.0;
        if (coord0 * coord1 < 0.0) {
            let denom = max(1e-5, abs(coord0) + abs(coord1));
            leftFrac = select(abs(coord1) / denom, abs(coord0) / denom, coord0 < 0.0);
        } else {
            leftFrac = select(0.0, 1.0, coord0 < 0.0);
        }
        zoneDist.x += hit.t * leftFrac;
        zoneDist.y += hit.t * (1.0 - leftFrac);

        // Mild travel absorption per segment to calm overly strong bounce loops.
        let leftTravelAbsorb = vec3<f32>(0.20, 0.40, 0.10);
        let rightTravelAbsorb = vec3<f32>(0.10, 0.20, 0.40);
        let segmentAbsorb = leftTravelAbsorb * leftFrac + rightTravelAbsorb * (1.0 - leftFrac);
        let travelStrength = (1.0 - uniforms.clarity) * 0.60 + 0.07;
        let travelAttenuation = exp(-(segmentAbsorb * travelStrength) * hit.t);

        // Add the distance traveled in this segment to the total
        totalDist += hit.t;

        var n = normalize(hit.normal);
        if (dot(g, n) > 0.0) { n = -n; }

        if (hit.frosted > 0.5) {
            let n_world = normalize((uniforms.modelMatrix * vec4<f32>(n, 0.0)).xyz);
            let glow = mix(vec3<f32>(0.82, 0.84, 0.86), uniforms.stoneColor, 0.30);
            let diffuse = max(0.0, n_world.z);
            let refl = reflect(g, n);
            let reflected = sample_env_view((mvMatrix * vec4<f32>(refl, 0.0)).xyz) * mix(vec3<f32>(1.0), uniforms.stoneColor, 0.18) * 0.32;
            accumulated += throughput * (glow * (0.54 + 0.24 * diffuse) + reflected);
            break;
        }

        // Per-channel cos(θ_i) — vectorised across R/G/B
        let cosI = vec3<f32>(max(0.0, dot(-r, n)), max(0.0, dot(-g, n)), max(0.0, dot(-b, n)));

        // sin²(θ_t) = eta² · sin²(θ_i)  —  Snell gem→air
        let st = (1.0 - cosI * cosI) * eta * eta;

        // Vectorised Fresnel (TIR = 1.0 when sin²θ_t ≥ 1)
        let tir     = st >= vec3<f32>(1.0);
        let ct      = sqrt(clamp(1.0 - st, vec3<f32>(0.0), vec3<f32>(1.0)));
        let rs      = (eta * cosI - ct) / (eta * cosI + ct);
        let rp      = (cosI - eta * ct) / (cosI + eta * ct);
        let fresnel = select(0.5 * (rs * rs + rp * rp), vec3<f32>(1.0), tir);

        // Window detection — dot-product extracts z without full mat4×vec4
        let outZ = dot(modelNZ, hit.normal);
        if (outZ < -0.1) {
            windowLeak += throughput * (1.0 - fresnel) * max(0.0, -outZ);
        }

        // Refracted escape contribution per channel
        // length() guard is redundant: refract() is only called when st < 1 (no TIR)
        if (st.x < 1.0) {
            accumulated.x += throughput.x * sample_env_view((mvMatrix * vec4<f32>(refract(r, n, eta.x), 0.0)).xyz).r * (1.0 - fresnel.x);
        }
        if (st.y < 1.0) {
            accumulated.y += throughput.y * sample_env_view((mvMatrix * vec4<f32>(refract(g, n, eta.y), 0.0)).xyz).g * (1.0 - fresnel.y);
        }
        if (st.z < 1.0) {
            accumulated.z += throughput.z * sample_env_view((mvMatrix * vec4<f32>(refract(b, n, eta.z), 0.0)).xyz).b * (1.0 - fresnel.z);
        }

        // Advance origin along green ray; reflect all three channels
        origin      = origin + g * hit.t + n * 1e-4;
        let refl_r   = reflect(r, n);
        let refl_g   = reflect(g, n);
        let refl_b   = reflect(b, n);
        r           = refl_r;
        g           = refl_g;
        b           = refl_b;
        throughput *= fresnel * travelAttenuation;
        if (all(throughput < vec3<f32>(0.001))) { break; }
    }

    var result: TraceResult;
    result.light  = accumulated;
    result.window = clamp(windowLeak, vec3<f32>(0.0), vec3<f32>(1.0));
    result.dist   = totalDist;
    result.zoneDist = zoneDist;
    return result;
}

// ─────────────────────────────────────────────────
// Fragment shader
// ─────────────────────────────────────────────────
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let V_world = normalize(input.worldPosition - uniforms.cameraPosition);
    var N_world = normalize(input.worldNormal);
    let graph = uniforms.graphMode > 0.5;

    // Wider overlap for gentler material transition.
    let splitMix = smoothstep(-0.20, 0.20, input.localPos.x);
    let leftMaterialColor = vec3<f32>(0.60, 0.24, 0.86);
    let rightMaterialColor = vec3<f32>(1.00, 0.68, 0.20);
    let materialStoneColor = mix(leftMaterialColor, rightMaterialColor, splitMix);
    let stoneColor = select(vec3<f32>(1.0), materialStoneColor, !graph);

    let isFrontFace = dot(V_world, N_world) < 0.0;
    if (!isFrontFace) { N_world = -N_world; }

    // Flat shading mode — multi-light Lambert + Blinn-Phong, no raytracing
    if (uniforms.flatShading > 0.5) {
        let NdotV = max(0.0, dot(-V_world, N_world));

        let N_view = normalize((uniforms.viewMatrix * vec4<f32>(N_world, 0.0)).xyz);

        // Four area-spread key lights — directions, diffuse weights, specular exponent
        let L0 = vec3<f32>( 0.6,  0.4,  0.7); // front-right top  (warm key)
        let L1 = vec3<f32>(-0.5,  0.3,  0.8); // front-left top   (fill)
        let L2 = vec3<f32>( 0.1, -0.6,  0.6); // back-right mid   (accent)
        let L3 = vec3<f32>(-0.2,  0.8,  0.3); // left rim         (edge)

        // Diffuse — wider falloff (pow 1 = Lambert)
        let d0 = max(0.0, dot(N_view, L0));
        let d1 = max(0.0, dot(N_view, L1)) * 0.55;
        let d2 = max(0.0, dot(N_view, L2)) * 0.35;
        let d3 = max(0.0, dot(N_view, L3)) * 0.25;
        let diffuse = 0.04 + d0 + d1 + d2 + d3 - 0.25;

        // Specular — lower exponent = wider/softer highlight per light
        let V_view = normalize((uniforms.viewMatrix * vec4<f32>(V_world, 0.0)).xyz);
        let H0 = normalize(L0 - V_view);
        let H1 = normalize(L1 - V_view);
        let H2 = normalize(L2 - V_view);
        let H3 = normalize(L3 - V_view);
        let s0 = pow(dot(N_view, H0), 22.0) * 0.55;
        let s1 = pow(dot(N_view, H1), 18.0) * 0.35;
        let s2 = pow(dot(N_view, H2), 14.0) * 0.20;
        let s3 = pow(dot(N_view, H3), 10.0) * 0.15;
        let spec = s0 + s1 + s2 + s3;

        // Silhouette rim
        let rim = pow(1.0 - NdotV, 4.0) * 0.25;

        let col = stoneColor * (diffuse * 0.6 + 0.4) + vec3<f32>(spec + rim);
        return vec4<f32>(aces_tonemap_fast(col * 0.3), 1.0);
    }

    // For a rotation-only model matrix, inverse = transpose of the 3×3 submatrix.
    // mat3×vec3 is 9 muls + 6 adds vs mat4×vec4's 16 muls + 12 adds.
    let mCol0   = uniforms.modelMatrix[0].xyz;
    let mCol1   = uniforms.modelMatrix[1].xyz;
    let mCol2   = uniforms.modelMatrix[2].xyz;
    let V_local = normalize(vec3<f32>(dot(V_world, mCol0), dot(V_world, mCol1), dot(V_world, mCol2)));
    let N_local = normalize(vec3<f32>(dot(N_world, mCol0), dot(N_world, mCol1), dot(N_world, mCol2)));
    let faceDx = dpdx(input.localPos);
    let faceDy = dpdy(input.localPos);
    let faceN = normalize(cross(faceDx, faceDy));
    let tableMask = select(0.0, 1.0, abs(faceN.z) > 0.995);

    if (input.frosted > 0.5) {
        let upLight = max(0.0, N_world.z);
        let NdotV_frost = max(0.0, dot(-V_world, N_world));
        let rim = pow(1.0 - NdotV_frost, 1.6);
        let frostFresnel = 0.18 + 0.28 * pow(1.0 - NdotV_frost, 3.0);
        let frostRefl = sample_env(reflect(V_world, N_world)) * mix(vec3<f32>(1.0), stoneColor, 0.30) * frostFresnel;
        let frostWhite = mix(vec3<f32>(0.88, 0.90, 0.92), stoneColor, 0.42);
        let frostDiffuse = frostWhite * (0.66 + 0.18 * upLight) + vec3<f32>(0.14) * rim;
        let frostColor = frostDiffuse + frostRefl;
        if (graph) {
            let rawLuminance = dot(frostColor, vec3<f32>(0.2126, 0.7152, 0.0722));
            return vec4<f32>(rawLuminance, rawLuminance * tableMask, tableMask, 1.0);
        }
        return vec4<f32>(aces_tonemap_fast(frostColor), 0.98);
    }

    // Keep optical behavior stable per path: single RI avoids facet-to-facet
    // amber/purple flip patterns from side-dependent RI switching.
    let ri      = cauchy_ri3(uniforms.ri_d, uniforms.cod); // vec3(ri_r, ri_g, ri_b)
    let ri_r    = ri.x;
    let ri_g    = ri.y;
    let ri_b    = ri.z;

    let f0      = pow((ri_g - 1.0) / (ri_g + 1.0), 2.0);
    let fresnel = f0 + (1.0 - f0) * pow(1.0 - max(0.0, dot(-V_world, N_world)), 5.0);

    let refl_dir   = reflect(V_world, N_world);
    let reflection = sample_env(refl_dir) * fresnel;

    let refr_rd_r = refract(V_local, N_local, 1.0 / ri_r);
    let refr_rd_g = refract(V_local, N_local, 1.0 / ri_g);
    let refr_rd_b = refract(V_local, N_local, 1.0 / ri_b);

    // Precompute model-view matrix once — shared across all bounce env samples (up to 60× per fragment).
    let mvMatrix = uniforms.viewMatrix * uniforms.modelMatrix;
    // Z-row of modelMatrix for fast outZ extraction via dot product.
    let modelNZ  = vec3<f32>(uniforms.modelMatrix[0][2], uniforms.modelMatrix[1][2], uniforms.modelMatrix[2][2]);

    let entry = input.localPos;
    let tr    = trace_internal(refr_rd_r, refr_rd_g, refr_rd_b, entry, ri, mvMatrix, modelNZ);

    let clarity = uniforms.clarity;
    // Path-based color mixing: distance traveled in each half drives absorption.
    let leftAbsorption = vec3<f32>(0.92, 1.95, 0.15);
    let rightAbsorption = vec3<f32>(0.18, 0.40, 1.72);
    let absorptionStrength = (1.0 - clarity) * 1.28 + 0.16;
    let transmission = exp(-(leftAbsorption * absorptionStrength) * tr.zoneDist.x)
                     * exp(-(rightAbsorption * absorptionStrength) * tr.zoneDist.y);


    // Apply to the internal light and window leakage
    let finalInternalLight = tr.light * transmission ;
    let reflectionTransmission = mix(1.0, dot(transmission, vec3<f32>(0.3333, 0.3333, 0.3333)), 0.35);
    let baseColor = reflection * reflectionTransmission + finalInternalLight * (1.0 - fresnel);

    // Dedicated graph mode: emit raw pre-tonemap luminance directly.
    // This avoids ACES tonemapping, 8-bit quantization bias, and the
    // artistic scintillation boost used in the normal display path.
    if (graph) {
        let rawLuminance = dot(baseColor, vec3<f32>(0.2126, 0.7152, 0.0722));
        return vec4<f32>(rawLuminance, rawLuminance * tableMask, tableMask, 1.0);
    }

    var finalColor = baseColor;

    // Window effect: average downward leakage across the three channels,
    // scaled by exitStrength slider.
    let windowAmount = (tr.window.x + tr.window.y + tr.window.z) / 3.0;
    let windowTinted = uniforms.exitHighlight * windowAmount * uniforms.exitStrength;
    finalColor += windowTinted * (1.0 - fresnel);

    // Scintillation
    let lum = dot(finalColor, vec3<f32>(0.21, 0.72, 0.07));
    // finalColor += pow(lum, 12.0) * 10.0;
    // Pre-compute using cheaper approximations
    let lum2 = lum * lum;
    let lum4 = lum2 * lum2;
    let lum8 = lum4 * lum4;
    finalColor += lum8 * lum4 * 10.0; // Equivalent to pow(lum, 12)

    let alpha = 1.0;
    return vec4<f32>(aces_tonemap_fast(finalColor * 1.5), alpha);
}
