"""The names a material's hashed texture slots and constants can be given back.

`MaterialTextureDef.nameHash` and `MaterialConstantDef.nameHash` are `R_HashString`
of a name the shaders declare: a texture slot is a sampler (`colorMapSampler`, whose
slot is also `colorMap`), a constant a float register (`colorTint`). So the names
are read out of the D3D9 constant table (`CTAB`) of every shader the zone holds,
plus a fixed list of the engine's own that no shader in a given zone may declare.
This is the lookup OpenAssetTools builds for the same purpose, over the same zone,
for IW4 and IW5 alike.
"""

import struct

from ...iw6.dumpers.material import slot_hash

OPCODE_COMMENT, OPCODE_END = 0xFFFE, 0xFFFF
CTAB = int.from_bytes(b"CTAB", "little")
SAMPLER = 3  # D3DXRS_SAMPLER
SAMPLER_SUFFIX = "Sampler"

# Code constants and code textures the engine binds itself.
KNOWN_CONSTANTS = """
worldViewProjectionMatrix worldViewMatrix2 worldViewMatrix1 worldViewMatrix worldOutdoorLookupMatrix worldMatrix
waterColor viewportDimensions viewProjectionMatrix uvScale uvAnimParms thermalColorOffset sunShadowmapPixelAdjust
ssaoParms spotShadowmapPixelAdjust shadowmapSwitchPartition shadowmapScale shadowmapPolygonOffset shadowLookupMatrix
renderTargetSize renderSourceSize projectionMatrix playlistPopulationParams pixelCostFracs pixelCostDecode
particleCloudSparkColor2 particleCloudSparkColor1 particleCloudSparkColor0 particleCloudMatrix2 particleCloudMatrix1
particleCloudMatrix particleCloudColor outdoorFeatherParms oceanUVAnimParmPaintedFoam oceanUVAnimParmOctave2
oceanUVAnimParmOctave1 oceanUVAnimParmOctave0 oceanUVAnimParmFoam oceanUVAnimParmDetail1 oceanUVAnimParmDetail0
oceanScrollParms oceanMiscParms oceanFoamParms oceanAmplitude materialColor lightprobeAmbient lightingLookupScale
lightSpotFactors lightSpotDir lightSpecular lightPosition lightFalloffPlacement lightDiffuse inverseWorldViewMatrix
inverseViewProjectionMatrix inverseTransposeWorldViewMatrix heatMapDetail glowSetup glowApply gameTime
fullscreenDistortion fogSunDir fogSunConsts fogSunColorLinear fogSunColorGamma fogConsts fogColorLinear fogColorGamma
flagParms filterTap featherParms falloffParms falloffEndColor falloffBeginColor fadeEffect eyeOffsetParms eyeOffset
envMapParms dustTint dustParms dustEyeParms dofRowDelta dofLerpScale dofLerpBias dofEquationViewModelAndFarBlur
dofEquationScene distortionScale detailScale depthFromClip debugBumpmap colorTintQuadraticDelta colorTintDelta
colorTintBase colorSaturationR colorSaturationG colorSaturationB colorObjMin colorObjMax colorMatrixR colorMatrixG
colorMatrixB colorBias codeMeshArg clipSpaceLookupScale clipSpaceLookupOffset baseLightingCoords
""".split()
KNOWN_TEXTURES = """
attenuation attenuationSampler cinematicA cinematicASampler cinematicCb cinematicCbSampler cinematicCr
cinematicCrSampler cinematicY cinematicYSampler colorMap colorMap1 colorMap2 colorMapPostSun colorMapPostSunSampler
colorMapSampler colorMapSampler1 colorMapSampler2 cucoloris cucolorisSampler detailMap detailMapSampler dust dustMap
dustSampler fadeMap fadeMapSampler floatZ floatZSampler grainMap grainMapSampler halfParticleColor
halfParticleColorSampler halfParticleDepth halfParticleDepthSampler heatmap heatmapSampler lightmapPrimary
lightmapSamplerPrimary lightmapSamplerSecondary lightmapSecondary lookupMap lookupMapSampler modelLighting
modelLightingMap modelLightingSampler normalMap normalMapSampler oceanColorRamp oceanColorRampMap
oceanColorRampSampler oceanDetailNormal oceanDetailNormalMap oceanDetailNormalSampler oceanDisplacement
oceanDisplacementMap oceanDisplacementSampler oceanEnv oceanEnvMap oceanEnvSampler oceanFoam oceanFoamMap
oceanFoamSampler oceanHeightNormal oceanHeightNormalMap oceanHeightNormalSampler oceanPaintedFoam oceanPaintedFoamMap
oceanPaintedFoamSampler outdoorMap outdoorMapSampler population populationSampler reflectionProbe
reflectionProbeSampler shadowmapSamplerSpot shadowmapSamplerSun shadowmapSpot shadowmapSun skyMap skyMapSampler
specularMap specularMapSampler ssao ssaoSampler worldMap worldMapSampler
""".split()
# OAT's IW4 list (MaterialConstantZoneStateIW4.cpp) is IW5's without these; a hash
# no shader declares either stays a hash, so the difference is visible in the dump.
IW5_ONLY_TEXTURES = set(
    "dustMap modelLightingMap oceanColorRampMap oceanDetailNormalMap oceanDisplacementMap oceanEnvMap oceanFoamMap "
    "oceanHeightNormalMap oceanPaintedFoamMap".split()
)
KNOWN_TEXTURES_BY_GAME = {"iw4": [n for n in KNOWN_TEXTURES if n not in IW5_ONLY_TEXTURES], "iw5": KNOWN_TEXTURES}


def constant_table(program):
    """[(name, register set)] from a D3D9 shader's CTAB comment; [] when it has none or it does not parse."""
    words = len(program) // 4
    pos = 1  # after the version token
    while pos < words:
        token = struct.unpack_from("<I", program, 4 * pos)[0]
        if token == OPCODE_END:
            return []
        if token & 0xFFFF == OPCODE_COMMENT:
            size = token >> 16
            if pos + 1 < words and struct.unpack_from("<I", program, 4 * (pos + 1))[0] == CTAB:
                start, length = 4 * (pos + 2), 4 * (size - 1)
                return _parse(bytes(program[start : start + length]))
            pos += size
        pos += 1
    return []


def _parse(comment):
    try:
        size, _creator, _version, count, info, _flags, _target = struct.unpack_from("<7I", comment, 0)
        if size != 28:
            return []
        out = []
        for k in range(count):
            name_at, register_set = struct.unpack_from("<IH", comment, info + 20 * k)
            end = comment.index(b"\0", name_at) if name_at else None
            name = comment[name_at:end].decode("latin-1") if name_at else ""
            out.append((name, register_set))
        return out
    except (struct.error, ValueError):
        return []


class ZoneNames:
    """Hash -> name, for texture slots and for constants, from one zone's shaders."""

    def __init__(self, walk):
        self.textures, self.constants = {}, {}
        for name in KNOWN_CONSTANTS:
            self._add(self.constants, name)
        for name in KNOWN_TEXTURES_BY_GAME[walk.game]:
            self._add(self.textures, name)
        for kind in ("vertexshader", "pixelshader"):
            for asset in walk.by_type(kind):
                program = asset.record["prog.loadDef.program"]
                if asset.name.startswith(",") or program is None:
                    continue
                for name, register_set in constant_table(program.bytes()):
                    if register_set == SAMPLER:
                        if self._add(self.textures, name) and SAMPLER_SUFFIX in name:
                            cut = name.rfind(SAMPLER_SUFFIX)
                            self._add(self.textures, name[:cut] + name[cut + len(SAMPLER_SUFFIX) :])
                    else:
                        self._add(self.constants, name)

    @staticmethod
    def hash(name):
        return slot_hash(name)

    @staticmethod
    def _add(table, name):
        key = slot_hash(name)
        if key in table:
            return False
        table[key] = name
        return True

    def texture(self, name_hash):
        return self.textures.get(name_hash)

    def constant(self, name_hash):
        return self.constants.get(name_hash)
