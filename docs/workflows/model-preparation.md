# Model Preparation Workflow

Model preparation sets up reliable geometry and orientation before supports.

## Recommended sequence

1. Import model.
2. Inspect scale and orientation.
3. Rotate for printability and drainage strategy.
4. Apply lift/position policy to clear the build plate.
5. [Optional] Hollow the model and add hole punches for drainage.
6. Verify bounding behavior and placement.

## Practical checks

- Overhang-heavy regions are accessible for support contact.
- Critical details are not aimed directly into peel-heavy failure zones.
- Model is not unintentionally intersecting the plate.
- Hollow shell thickness meets minimum print requirements.

## Multi-model notes

When multiple models are loaded:

- Confirm the intended active model before transforms.
- Re-check support ownership after model selection changes.

## Related workflows

- [Hollowing and Hole Punch](./hollowing.md)
- [Transform and Positioning](./transform-and-positioning.md)
- [Arrange Models](./arrange-models.md)
- [Duplicate Models](./duplicate-models.md)

![Model prep placeholder](../assets/placeholders/model-preparation.png)

> Screenshot placeholder: model transform controls in use with before/after orientation.
