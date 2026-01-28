/**
 * git-snapshot.ts - Automatic project versioning on memory saves
 *
 * Creates commits on a hidden branch after each memory extraction,
 * providing full project history tied to your working sessions.
 */

import { execSync } from "child_process";
import * as path from "path";

const SNAPSHOT_BRANCH = "__memory-snapshots";

interface SnapshotConfig {
  enabled: boolean;
  remote?: string; // e.g., "origin"
  branch: string;  // e.g., "__memory-snapshots"
}

interface SnapshotResult {
  success: boolean;
  commitHash?: string;
  error?: string;
}

/**
 * Check if directory is a git repository
 */
export function isGitRepo(projectDir: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: projectDir,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current branch name
 */
function getCurrentBranch(projectDir: string): string {
  return execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: projectDir,
    encoding: "utf-8",
  }).trim();
}

/**
 * Check if remote exists
 */
export function remoteExists(projectDir: string, remote: string): boolean {
  try {
    const remotes = execSync("git remote", {
      cwd: projectDir,
      encoding: "utf-8",
    });
    return remotes.split("\n").includes(remote);
  } catch {
    return false;
  }
}

/**
 * Check if snapshot branch exists (local or remote)
 */
function snapshotBranchExists(projectDir: string, branch: string): boolean {
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${branch}`, {
      cwd: projectDir,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the snapshot branch if it doesn't exist
 */
function ensureSnapshotBranch(projectDir: string, branch: string): void {
  if (!snapshotBranchExists(projectDir, branch)) {
    // Create orphan branch with initial commit
    execSync(`git checkout --orphan ${branch}`, {
      cwd: projectDir,
      stdio: "pipe",
    });
    execSync('git commit --allow-empty -m "Initialize memory snapshots"', {
      cwd: projectDir,
      stdio: "pipe",
    });
  }
}

/**
 * Generate a commit message from memory extraction context
 */
export function generateCommitMessage(
  memoriesAdded: number,
  memoryTypes: string[],
  hookEvent: string
): string {
  const timestamp = new Date().toISOString();
  const types = [...new Set(memoryTypes)].join(", ");

  if (memoriesAdded === 0) {
    return `snapshot: ${hookEvent} at ${timestamp}`;
  }

  return `snapshot: +${memoriesAdded} memories (${types}) [${hookEvent}]\n\nTimestamp: ${timestamp}`;
}

/**
 * Create a snapshot commit on the hidden branch
 */
export async function createSnapshot(
  projectDir: string,
  config: SnapshotConfig,
  commitMessage: string
): Promise<SnapshotResult> {
  if (!config.enabled) {
    return { success: false, error: "Snapshots not enabled" };
  }

  if (!isGitRepo(projectDir)) {
    return { success: false, error: "Not a git repository" };
  }

  const branch = config.branch || SNAPSHOT_BRANCH;
  const originalBranch = getCurrentBranch(projectDir);

  try {
    // Stash any uncommitted changes on the original branch
    let hasStash = false;
    try {
      const stashResult = execSync("git stash push -u -m 'memory-mcp-snapshot'", {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
      hasStash = !stashResult.includes("No local changes");
    } catch {
      // No changes to stash, continue
    }

    // Ensure snapshot branch exists
    ensureSnapshotBranch(projectDir, branch);

    // Switch to snapshot branch
    execSync(`git checkout ${branch}`, {
      cwd: projectDir,
      stdio: "pipe",
    });

    // Merge in all current files from the original branch
    // Using checkout to get the exact state
    execSync(`git checkout ${originalBranch} -- .`, {
      cwd: projectDir,
      stdio: "pipe",
    });

    // Stage all changes
    execSync("git add -A", {
      cwd: projectDir,
      stdio: "pipe",
    });

    // Check if there are changes to commit
    let hasChanges = false;
    try {
      execSync("git diff --cached --quiet", {
        cwd: projectDir,
        stdio: "pipe",
      });
    } catch {
      hasChanges = true;
    }

    let commitHash: string | undefined;

    if (hasChanges) {
      // Commit
      execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
        cwd: projectDir,
        stdio: "pipe",
      });

      // Get commit hash
      commitHash = execSync("git rev-parse HEAD", {
        cwd: projectDir,
        encoding: "utf-8",
      }).trim();

      // Push if remote is configured
      if (config.remote) {
        try {
          execSync(`git push ${config.remote} ${branch}`, {
            cwd: projectDir,
            stdio: "pipe",
          });
        } catch (pushError: any) {
          // First push might need -u flag
          execSync(`git push -u ${config.remote} ${branch}`, {
            cwd: projectDir,
            stdio: "pipe",
          });
        }
      }
    }

    // Switch back to original branch
    execSync(`git checkout ${originalBranch}`, {
      cwd: projectDir,
      stdio: "pipe",
    });

    // Restore stash if we had one
    if (hasStash) {
      try {
        execSync("git stash pop", {
          cwd: projectDir,
          stdio: "pipe",
        });
      } catch {
        // Stash pop failed, leave it in stash
      }
    }

    return {
      success: true,
      commitHash,
    };
  } catch (error: any) {
    // Try to recover - switch back to original branch
    try {
      execSync(`git checkout ${originalBranch}`, {
        cwd: projectDir,
        stdio: "pipe",
      });
    } catch {
      // Already on original branch or other issue
    }

    return {
      success: false,
      error: error.message || String(error),
    };
  }
}

/**
 * Get default config
 */
export function getDefaultSnapshotConfig(): SnapshotConfig {
  return {
    enabled: false,
    branch: SNAPSHOT_BRANCH,
  };
}

/**
 * List snapshot history
 */
export function listSnapshots(
  projectDir: string,
  branch: string = SNAPSHOT_BRANCH,
  limit: number = 20
): Array<{ hash: string; date: string; message: string }> {
  if (!isGitRepo(projectDir)) {
    return [];
  }

  if (!snapshotBranchExists(projectDir, branch)) {
    return [];
  }

  try {
    const log = execSync(
      `git log ${branch} --pretty=format:"%H|%ai|%s" -n ${limit}`,
      {
        cwd: projectDir,
        encoding: "utf-8",
      }
    );

    return log
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => {
        const [hash, date, message] = line.split("|");
        return { hash, date, message };
      });
  } catch {
    return [];
  }
}

/**
 * Show diff between two snapshots
 */
export function diffSnapshots(
  projectDir: string,
  fromHash: string,
  toHash: string
): string {
  try {
    return execSync(`git diff ${fromHash} ${toHash} --stat`, {
      cwd: projectDir,
      encoding: "utf-8",
    });
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * Restore project to a specific snapshot (creates a new commit on main branch)
 */
export function restoreSnapshot(
  projectDir: string,
  snapshotHash: string
): { success: boolean; error?: string } {
  try {
    const currentBranch = getCurrentBranch(projectDir);

    // Checkout files from the snapshot
    execSync(`git checkout ${snapshotHash} -- .`, {
      cwd: projectDir,
      stdio: "pipe",
    });

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
