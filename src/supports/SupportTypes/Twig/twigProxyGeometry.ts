import { registerSupportProxyGeometry } from '../../proxyGeometry/seam';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import type { ContactDisk } from '../../types';
import type { Twig } from '../../types';

/** Where a disk's tip sits, past its standoff along the surface normal. */
function diskTipCenter(disk: ContactDisk) {
  const thickness = disk.diskLengthOverride ?? calculateDiskThickness(disk.surfaceNormal, disk.coneAxis, disk.profile);
  return {
    x: disk.pos.x + (disk.surfaceNormal.x * thickness),
    y: disk.pos.y + (disk.surfaceNormal.y * thickness),
    z: disk.pos.z + (disk.surfaceNormal.z * thickness),
  };
}

/**
 * A twig works between two contact disks, so its shaft runs from one disk's tip
 * to the other's. Both disks are emitted as cones whose body fills the disk, and
 * the joints take the SEGMENT's diameter rather than the joint's.
 */
registerSupportProxyGeometry<Twig>('twig', (twig, ctx) => {
  if (ctx.includeDetailedPrimitives) {
    ctx.pushCone({
      id: twig.contactDiskA.id,
      supportId: twig.id,
      modelId: twig.modelId,
      pos: twig.contactDiskA.pos,
      normal: twig.contactDiskA.coneAxis,
      surfaceNormal: twig.contactDiskA.surfaceNormal,
      diskLengthOverride: twig.contactDiskA.diskLengthOverride,
      profile: {
        type: 'disk',
        contactDiameterMm: twig.contactDiskA.contactDiameterMm,
        bodyDiameterMm: twig.contactDiskA.contactDiameterMm,
        lengthMm: 0.001,
        penetrationMm: 0,
        diskThicknessMm: twig.contactDiskA.profile.diskThicknessMm,
        maxStandoffMm: twig.contactDiskA.profile.maxStandoffMm,
        standoffAngleThreshold: twig.contactDiskA.profile.standoffAngleThreshold,
      },
    });
    ctx.pushCone({
      id: twig.contactDiskB.id,
      supportId: twig.id,
      modelId: twig.modelId,
      pos: twig.contactDiskB.pos,
      normal: twig.contactDiskB.coneAxis,
      surfaceNormal: twig.contactDiskB.surfaceNormal,
      diskLengthOverride: twig.contactDiskB.diskLengthOverride,
      profile: {
        type: 'disk',
        contactDiameterMm: twig.contactDiskB.contactDiameterMm,
        bodyDiameterMm: twig.contactDiskB.contactDiameterMm,
        lengthMm: 0.001,
        penetrationMm: 0,
        diskThicknessMm: twig.contactDiskB.profile.diskThicknessMm,
        maxStandoffMm: twig.contactDiskB.profile.maxStandoffMm,
        standoffAngleThreshold: twig.contactDiskB.profile.standoffAngleThreshold,
      },
    });
  }

  for (const segment of twig.segments) {
    if (ctx.includeDetailedPrimitives && segment.bottomJoint) {
      ctx.pushJoint({
        id: segment.bottomJoint.id,
        pos: segment.bottomJoint.pos,
        diameter: segment.diameter,
        supportId: twig.id,
        modelId: twig.modelId,
      });
    }

    const start = segment.bottomJoint?.pos ?? diskTipCenter(twig.contactDiskA);
    const end = segment.topJoint?.pos ?? diskTipCenter(twig.contactDiskB);

    ctx.pushSegmentShafts(segment, start, end, twig.id, twig.modelId);

    if (ctx.includeDetailedPrimitives && segment.topJoint) {
      ctx.pushJoint({
        id: segment.topJoint.id,
        pos: segment.topJoint.pos,
        diameter: segment.diameter,
        supportId: twig.id,
        modelId: twig.modelId,
      });
    }
  }
});
