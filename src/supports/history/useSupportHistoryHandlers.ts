import { useEffect } from 'react';
import { registerHistoryHandler } from '@/history/historyStore';
import {
  SUPPORT_ADD_TRUNK,
  SUPPORT_ADD_LEAF,
  SUPPORT_ADD_BRANCH,
  SUPPORT_ADD_TWIG,
  SUPPORT_ADD_STICK,
  SUPPORT_ADD_BRACE,
  SUPPORT_REMOVE_TRUNK,
  SUPPORT_REMOVE_LEAF,
  SUPPORT_REMOVE_BRANCH,
  SUPPORT_REMOVE_TWIG,
  SUPPORT_REMOVE_STICK,
  SUPPORT_REMOVE_BRACE,
  SUPPORT_UPDATE_TRUNK,
  SUPPORT_UPDATE_BRANCH,
  SUPPORT_ADD_KICKSTAND,
  SUPPORT_REMOVE_KICKSTAND,
  SUPPORT_REPLACE_TRUNK,
  SUPPORT_EDIT_REPLACE,
  SUPPORT_AUTO_BRACE_REPLACE,
  SupportLeafPayload,
  SupportBranchPayload,
  SupportTwigPayload,
  SupportStickPayload,
  SupportBranchRemovePayload,
  BraceLinkPayload,
  SupportTrunkPayload,
  SupportTrunkUpdatePayload,
  SupportBranchUpdatePayload,
  SupportReplaceTrunkPayload,
  SupportReplaceStatePayload,
  SupportKickstandPayload,
  SupportKickstandRemovePayload,
} from './actionTypes';
import { addKnot, addLeaf, addRoot, addTrunk, addBranch, addTwig, addStick, addBrace, removeLeaf, removeTrunk, removeBranch, removeTwig, removeStick, removeBrace, removeKickstandCascade, updateTrunk, updateBranch, updateKnot, setSnapshot } from '../state';
import { addKickstand, setKickstandSnapshot } from '../SupportTypes/Kickstand/kickstandStore';
import { clearSupportSelection } from '../interaction/shared/selection/selectionController';

function applySnapshotHistory(payload: SupportReplaceStatePayload, direction: 'undo' | 'redo') {
  clearSupportSelection();
  if (direction === 'undo') {
    setSnapshot(payload.before);
    if (payload.kickstandBefore) {
      setKickstandSnapshot(payload.kickstandBefore);
    }
  } else {
    setSnapshot(payload.after);
    if (payload.kickstandAfter) {
      setKickstandSnapshot(payload.kickstandAfter);
    }
  }
}

export function useSupportHistoryHandlers(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const unregisters = [
      registerHistoryHandler(SUPPORT_ADD_TRUNK, (action, direction) => {
        const payload = action.payload as SupportTrunkPayload | undefined;
        if (!payload?.trunk) return false;
        if (direction === 'undo') {
          removeTrunk(payload.trunk.id);
        } else {
          if (payload.root) addRoot(payload.root);
          addTrunk(payload.trunk);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_ADD_LEAF, (action, direction) => {
        const payload = action.payload as SupportLeafPayload | undefined;
        if (!payload?.leaf) return false;
        if (direction === 'undo') {
          removeLeaf(payload.leaf.id);
        } else {
          if (payload.knot) addKnot(payload.knot);
          addLeaf(payload.leaf);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_ADD_BRANCH, (action, direction) => {
        const payload = action.payload as SupportBranchPayload | undefined;
        if (!payload?.branch) return false;
        if (direction === 'undo') {
          removeBranch(payload.branch.id);
          for (const u of payload.knotUpdates ?? []) {
            updateKnot(u.before);
          }
          if (payload.trunkUpdate?.before) {
            updateTrunk(payload.trunkUpdate.before);
          }
        } else {
          if (payload.knot) addKnot(payload.knot);
          addBranch(payload.branch);
          for (const u of payload.knotUpdates ?? []) {
            updateKnot(u.after);
          }
          if (payload.trunkUpdate?.after) {
            updateTrunk(payload.trunkUpdate.after);
          }
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_ADD_TWIG, (action, direction) => {
        const payload = action.payload as SupportTwigPayload | undefined;
        if (!payload?.twig) return false;
        if (direction === 'undo') {
          removeTwig(payload.twig.id);
        } else {
          addTwig(payload.twig);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_ADD_STICK, (action, direction) => {
        const payload = action.payload as SupportStickPayload | undefined;
        if (!payload?.stick) return false;
        if (direction === 'undo') {
          removeStick(payload.stick.id);
        } else {
          addStick(payload.stick);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_ADD_BRACE, (action, direction) => {
        const payload = action.payload as BraceLinkPayload | undefined;
        if (!payload?.brace) return false;
        if (direction === 'undo') {
          removeBrace(payload.brace.id);
        } else {
          if (payload.startKnot) addKnot(payload.startKnot);
          if (payload.endKnot) addKnot(payload.endKnot);
          addBrace(payload.brace);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_REMOVE_TRUNK, (action, direction) => {
        const payload = action.payload as SupportTrunkPayload | undefined;
        if (!payload?.trunk) return false;
        if (direction === 'undo') {
          if (payload.root) addRoot(payload.root);
          addTrunk(payload.trunk);
          for (const knot of payload.knots ?? []) addKnot(knot);
          for (const leaf of payload.leaves ?? []) addLeaf(leaf);
          for (const brace of payload.braces ?? []) addBrace(brace);
          for (const kickstand of payload.kickstands ?? []) {
            addKickstand(kickstand);
            addRoot(kickstand.root);
            addKnot(kickstand.hostKnot);
          }
          for (const branch of payload.branches ?? []) addBranch(branch);
        } else {
          removeTrunk(payload.trunk.id);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_REMOVE_LEAF, (action, direction) => {
        const payload = action.payload as SupportLeafPayload | undefined;
        if (!payload?.leaf) return false;
        if (direction === 'undo') {
          if (payload.knot) addKnot(payload.knot);
          addLeaf(payload.leaf);
        } else {
          removeLeaf(payload.leaf.id);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_REMOVE_BRANCH, (action, direction) => {
        const payload = action.payload as SupportBranchRemovePayload | undefined;
        if (!payload?.branches || payload.branches.length === 0) return false;
        if (direction === 'undo') {
          for (const knot of payload.knots ?? []) addKnot(knot);
          for (const leaf of payload.leaves ?? []) addLeaf(leaf);
          for (const brace of payload.braces ?? []) addBrace(brace);
          for (const kickstand of payload.kickstands ?? []) {
            addKickstand(kickstand);
            addRoot(kickstand.root);
            addKnot(kickstand.hostKnot);
          }
          for (const branch of payload.branches ?? []) addBranch(branch);
          for (const u of payload.knotUpdates ?? []) {
            updateKnot(u.before);
          }
          if (payload.trunkUpdate?.before) {
            updateTrunk(payload.trunkUpdate.before);
          }
        } else {
          // Use the first removed branch as the entrypoint; the store handles cascade.
          removeBranch(payload.branches[0].id);
          for (const u of payload.knotUpdates ?? []) {
            updateKnot(u.after);
          }
          if (payload.trunkUpdate?.after) {
            updateTrunk(payload.trunkUpdate.after);
          }
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_REMOVE_TWIG, (action, direction) => {
        const payload = action.payload as SupportTwigPayload | undefined;
        if (!payload?.twig) return false;
        if (direction === 'undo') {
          addTwig(payload.twig);
        } else {
          removeTwig(payload.twig.id);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_REMOVE_STICK, (action, direction) => {
        const payload = action.payload as SupportStickPayload | undefined;
        if (!payload?.stick) return false;
        if (direction === 'undo') {
          addStick(payload.stick);
        } else {
          removeStick(payload.stick.id);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_REMOVE_BRACE, (action, direction) => {
        const payload = action.payload as BraceLinkPayload | undefined;
        if (!payload?.brace) return false;
        if (direction === 'undo') {
          if (payload.startKnot) addKnot(payload.startKnot);
          if (payload.endKnot) addKnot(payload.endKnot);
          addBrace(payload.brace);
        } else {
          removeBrace(payload.brace.id);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_ADD_KICKSTAND, (action, direction) => {
        const payload = action.payload as SupportKickstandPayload | undefined;
        if (!payload?.build) return false;
        if (direction === 'undo') {
          removeKickstandCascade(payload.build.kickstand.id);
        } else {
          addKickstand(payload.build);
          addRoot(payload.build.root);
          addKnot(payload.build.hostKnot);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_REMOVE_KICKSTAND, (action, direction) => {
        const payload = action.payload as SupportKickstandRemovePayload | undefined;
        if (!payload?.build) return false;
        if (direction === 'undo') {
          addRoot(payload.build.root);
          addKickstand(payload.build);
          addKnot(payload.build.hostKnot);
          for (const knot of payload.knots ?? []) addKnot(knot);
          for (const leaf of payload.leaves ?? []) addLeaf(leaf);
          for (const brace of payload.braces ?? []) addBrace(brace);
          for (const kickstand of payload.kickstands ?? []) {
            addKickstand(kickstand);
            addRoot(kickstand.root);
            addKnot(kickstand.hostKnot);
          }
          for (const branch of payload.branches ?? []) addBranch(branch);
        } else {
          removeKickstandCascade(payload.build.kickstand.id);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_UPDATE_TRUNK, (action, direction) => {
        const payload = action.payload as SupportTrunkUpdatePayload | undefined;
        if (!payload?.before || !payload?.after) return false;
        clearSupportSelection();
        if (direction === 'undo') {
          updateTrunk(payload.before);
        } else {
          updateTrunk(payload.after);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_UPDATE_BRANCH, (action, direction) => {
        const payload = action.payload as SupportBranchUpdatePayload | undefined;
        if (!payload?.before || !payload?.after) return false;
        clearSupportSelection();
        if (direction === 'undo') {
          updateBranch(payload.before);
        } else {
          updateBranch(payload.after);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_REPLACE_TRUNK, (action, direction) => {
        const payload = action.payload as SupportReplaceTrunkPayload | undefined;
        if (!payload?.before || !payload?.after) return false;
        clearSupportSelection();
        if (direction === 'undo') {
          setSnapshot(payload.before);
        } else {
          setSnapshot(payload.after);
        }
        return true;
      }),
      registerHistoryHandler(SUPPORT_EDIT_REPLACE, (action, direction) => {
        const payload = action.payload as SupportReplaceStatePayload | undefined;
        if (!payload?.before || !payload?.after) return false;
        applySnapshotHistory(payload, direction);
        return true;
      }),
      registerHistoryHandler(SUPPORT_AUTO_BRACE_REPLACE, (action, direction) => {
        const payload = action.payload as SupportReplaceStatePayload | undefined;
        if (!payload?.before || !payload?.after) return false;
        applySnapshotHistory(payload, direction);
        return true;
      }),
    ];

    return () => {
      unregisters.forEach((fn) => fn());
    };
  }, [enabled]);
}
