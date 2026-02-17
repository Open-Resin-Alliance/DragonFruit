# LYS Tip/Cone Versioned Baseline Log

## Purpose
Single running baseline log for repeated Lychee tip/cone experiments.
Do not create new markdown files per run; append new snapshots as Version N sections.

## External Insight Notes (Keep)
- Source note (from former Lychee/Alici contributor): tip points that are on the model may be stored/handled in model coordinates.
- Additional note: there can be multiple coordinate spaces in play (world, object-centered/static, and object-rotating/local).
- Why this matters for our tests: when comparing observed layer heights/positions, we must identify which geometric point and which coordinate space are being compared.

## Critical Orientation Fields (Previously Missed in this Log)
- `tipNormal` (vector): likely the most important orientation field for the tip cone axis on-model.
- `newTipNormal`: alternate/override normal when present.
- `objectIdTip` and `objectIdBase`: identify which object frame each endpoint belongs to.

These fields exist in the extracted JSON and must be tracked in every new version entry.

## Current Focus
Track only versions that include orientation fields (`tipNormal`, `newTipNormal`, `objectIdTip`, `objectIdBase`).

Capture these in each version for direct comparison:
1. support id / object id
2. `tip.x`, `tip.y`, `tip.z`
3. `base.x`, `base.y`, `base.z`
4. `settings.tip.length`, `settings.tip.diameter`, `settings.tip.pointDiameter`, `settings.tip.angle`
5. object `position`, `rotation`, `scale`

## Latest Comparison Table (V4 vs V5)

| Field | V4 | V5 |
|---|---:|---:|
| support id | s27924 | s27924 |
| object id | o8 | o8 |
| object position.z | 5 | 5 |
| object rotation.x (deg) | 75.42853749281504 | 75.42853749281504 |
| base.x | 10.77761692082305 | 9.121990661319948 |
| base.y | -8.32453016599219 | -8.32453016599219 |
| base.z | 0 | 0 |
| tip.x | 9.28688907623291 | 11.223440680619818 |
| tip.y | 2.258141756057718 | 3.7023026511440946 |
| tip.z | 9.574263572692889 | 9.982641150759893 |
| tipNormal | (0.13495933843234478, -0.2184120348899954, -0.9664792599870499) | (0.00045261160933668615, -0.7334671627157905, -0.6797247357279116) |
| base.joinLength | 8.481373231602909 | 3.7133116253081013 |
| tip.pointDiameter | 0.28 | 0.28 |
| tip.diameter | 1 | 1 |
| tip.angle | 100 | 100 |
| tip.length | 12.202638477911634 | 7.99996217266541 |

---

## Version 3 (V3)

## Source
- Scene JSON: `3. LysConversion/HW_Talpo_NoBase_01_Scene.json`
- Support ID: `s27924`
- Object ID: `o8`

## Object Transform (o8)
- position: x=0, y=0, z=5
- rotation: x=75.42853749281504, y=0, z=0
- scale: x=1, y=1, z=1
- center (formerCenter): x=66.77729797363281, y=-58.189537048339844, z=62.433528900146484

## Support Endpoint + Normal (s27924)
- base: x=10.77761692082305, y=-8.32453016599219, z=0
- tip: x=9.28688907623291, y=2.258141756057718, z=9.574263572692889
- baseNormal: x=0, y=0.9678345994380005, z=0.25158733698396885
- tipNormal: x=0.8290080054384853, y=-0.5305678836188039, z=-0.17675816187991863
- newTipNormal: null
- objectIdTip: o8
- objectIdBase: o8

## Support Settings Relevant to Trunk/Tip
- base.length: 0.25
- base.diameter: 5
- base.joinDiameter: 1
- base.joinLength: 8.481373231602909
- base.joinCone: 0.7
- base.newJoinLength: 1.07

- tip.type: cone
- tip.pointDiameter: 0.28
- tip.penetration: 0
- tip.diameter: 1
- tip.length: 9.940632756670356
- tip.breakPoint: 0
- tip.angle: 100

## Raw JSON Snippet (V3)
```json
"base": {
  "x": 10.77761692082305,
  "y": -8.32453016599219,
  "z": 0
},
"baseNormal": {
  "x": 0,
  "y": 0.9678345994380005,
  "z": 0.25158733698396885
},
"tip": {
  "x": 9.28688907623291,
  "y": 2.258141756057718,
  "z": 9.574263572692889
},
"settings": {
  "base": {
    "diameter": 5,
    "length": 0.25,
    "angle": 0,
    "joinDiameter": 1,
    "joinLength": 8.481373231602909,
    "joinCone": 0.7,
    "newJoinLength": 1.07
  },
  "tip": {
    "type": "cone",
    "pointDiameter": 0.28,
    "penetration": 0,
    "diameter": 1,
    "length": 9.940632756670356,
    "breakPoint": 0,
    "angle": 100
  }
}
```

## V2 -> V3 Quick Delta
- support id: unchanged (`s27924`)
- object id: unchanged (`o8`)
- `settings.tip.length`: `5.755571859330899` -> `9.940632756670356` (**increased by 4.185060897339457**)
- `settings.tip.angle`: unchanged (`100`)
- `tipNormal`: captured in this version and should be tracked going forward
- tip endpoint XYZ: unchanged
- base endpoint XYZ: unchanged
- base settings: unchanged
- object position/rotation/scale: unchanged

## Version 4 (V4)

## Source
- Scene JSON: `3. LysConversion/HW_Talpo_NoBase_01_Scene.json`
- Support ID: `s27924`
- Object ID: `o8`

## Object Transform (o8)
- position: x=0, y=0, z=5
- rotation: x=75.42853749281504, y=0, z=0
- scale: x=1, y=1, z=1
- center (formerCenter): x=66.77729797363281, y=-58.189537048339844, z=62.433528900146484

## Support Endpoint + Normal (s27924)
- base: x=10.77761692082305, y=-8.32453016599219, z=0
- tip: x=9.28688907623291, y=2.258141756057718, z=9.574263572692889
- baseNormal: x=0, y=0.9678345994380005, z=0.25158733698396885
- tipNormal: x=0.13495933843234478, y=-0.2184120348899954, z=-0.9664792599870499
- newTipNormal: null
- objectIdTip: o8
- objectIdBase: o8

## Support Settings Relevant to Trunk/Tip
- base.length: 0.25
- base.diameter: 5
- base.joinDiameter: 1
- base.joinLength: 8.481373231602909
- base.joinCone: 0.7
- base.newJoinLength: 1.07

- tip.type: cone
- tip.pointDiameter: 0.28
- tip.penetration: 0
- tip.diameter: 1
- tip.length: 12.202638477911634
- tip.breakPoint: 0
- tip.angle: 100

## Raw JSON Snippet (V4)
```json
"base": {
  "x": 10.77761692082305,
  "y": -8.32453016599219,
  "z": 0
},
"baseNormal": {
  "x": 0,
  "y": 0.9678345994380005,
  "z": 0.25158733698396885
},
"tipNormal": {
  "x": 0.13495933843234478,
  "y": -0.2184120348899954,
  "z": -0.9664792599870499
},
"newTipNormal": null,
"objectIdTip": "o8",
"objectIdBase": "o8",
"tip": {
  "x": 9.28688907623291,
  "y": 2.258141756057718,
  "z": 9.574263572692889
},
"settings": {
  "base": {
    "diameter": 5,
    "length": 0.25,
    "angle": 0,
    "joinDiameter": 1,
    "joinLength": 8.481373231602909,
    "joinCone": 0.7,
    "newJoinLength": 1.07
  },
  "tip": {
    "type": "cone",
    "pointDiameter": 0.28,
    "penetration": 0,
    "diameter": 1,
    "length": 12.202638477911634,
    "breakPoint": 0,
    "angle": 100
  }
}
```

## V3 -> V4 Quick Delta
- support id: unchanged (`s27924`)
- object id: unchanged (`o8`)
- `settings.tip.length`: `9.940632756670356` -> `12.202638477911634` (**increased by 2.262005721241278**)
- `tipNormal`: changed significantly
  - V3: `(0.8290080054384853, -0.5305678836188039, -0.17675816187991863)`
  - V4: `(0.13495933843234478, -0.2184120348899954, -0.9664792599870499)`
- `settings.tip.angle`: unchanged (`100`)
- tip endpoint XYZ: unchanged
- base endpoint XYZ: unchanged
- base settings: unchanged
- object position/rotation/scale: unchanged

---

## Version 5 (V5)

## Source
- Scene JSON: `3. LysConversion/HW_Talpo_NoBase_01_Scene.json`
- Support ID: `s27924`
- Object ID: `o8`

## Object Transform (o8)
- position: x=0, y=0, z=5
- rotation: x=75.42853749281504, y=0, z=0
- scale: x=1, y=1, z=1
- center (formerCenter): x=66.77729797363281, y=-58.189537048339844, z=62.433528900146484

## Support Endpoint + Normal (s27924)
- base: x=9.121990661319948, y=-8.32453016599219, z=0
- tip: x=11.223440680619818, y=3.7023026511440946, z=9.982641150759893
- baseNormal: x=0, y=0.9678345994380005, z=0.25158733698396885
- tipNormal: x=0.00045261160933668615, y=-0.7334671627157905, z=-0.6797247357279116
- newTipNormal: null
- objectIdTip: o8
- objectIdBase: o8

## Support Settings Relevant to Trunk/Tip
- base.length: 0.25
- base.diameter: 5
- base.joinDiameter: 1
- base.joinLength: 3.7133116253081013
- base.joinCone: 0.7
- base.newJoinLength: 1.07

- tip.type: cone
- tip.pointDiameter: 0.28
- tip.penetration: 0
- tip.diameter: 1
- tip.length: 7.99996217266541
- tip.breakPoint: 0
- tip.angle: 100

## Raw JSON Snippet (V5)
```json
"base": {
  "x": 9.121990661319948,
  "y": -8.32453016599219,
  "z": 0
},
"baseNormal": {
  "x": 0,
  "y": 0.9678345994380005,
  "z": 0.25158733698396885
},
"tipNormal": {
  "x": 0.00045261160933668615,
  "y": -0.7334671627157905,
  "z": -0.6797247357279116
},
"newTipNormal": null,
"objectIdTip": "o8",
"objectIdBase": "o8",
"tip": {
  "x": 11.223440680619818,
  "y": 3.7023026511440946,
  "z": 9.982641150759893
},
"settings": {
  "base": {
    "diameter": 5,
    "length": 0.25,
    "angle": 0,
    "joinDiameter": 1,
    "joinLength": 3.7133116253081013,
    "joinCone": 0.7,
    "newJoinLength": 1.07
  },
  "tip": {
    "type": "cone",
    "pointDiameter": 0.28,
    "penetration": 0,
    "diameter": 1,
    "length": 7.99996217266541,
    "breakPoint": 0,
    "angle": 100
  }
}
```

## V4 -> V5 Quick Delta
- support id: unchanged (`s27924`)
- object id: unchanged (`o8`)
- `base.x`: `10.77761692082305` -> `9.121990661319948` (**changed**)
- `tip.x`: `9.28688907623291` -> `11.223440680619818` (**changed**)
- `tip.y`: `2.258141756057718` -> `3.7023026511440946` (**changed**)
- `tip.z`: `9.574263572692889` -> `9.982641150759893` (**changed**)
- `tipNormal`: changed significantly
  - V4: `(0.13495933843234478, -0.2184120348899954, -0.9664792599870499)`
  - V5: `(0.00045261160933668615, -0.7334671627157905, -0.6797247357279116)`
- `base.joinLength`: `8.481373231602909` -> `3.7133116253081013` (**changed**)
- `settings.tip.length`: `12.202638477911634` -> `7.99996217266541` (**decreased by 4.202676305246224**)
- `settings.tip.angle`: unchanged (`100`)

