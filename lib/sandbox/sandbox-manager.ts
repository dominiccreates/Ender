import { SandboxProvider } from './types';
import { EventEmitter } from 'events';
import { appConfig } from '@/config/app.config';
import { SandboxFactory } from './factory';

interface SandboxInfo {
  sandboxId: string;
  provider: SandboxProvider;
  createdAt: Date;
  lastAccessed: Date;
}

class SandboxManager {
  private sandboxes: Map<string, SandboxInfo> = new Map();
  private timeoutWatchers: Map<string, NodeJS.Timeout> = new Map();
  private timeoutWarningCallbacks: ((sandboxId: string, remainingMs: number) => void)[] = [];
  private warningThresholdMs = 2 * 60 * 1000; // 2 minutes
  private activeSandboxId: string | null = null;

  /**
   * Get or create a sandbox provider for the given sandbox ID
   */
  async getOrCreateProvider(sandboxId: string): Promise<SandboxProvider> {
    // Check if we already have this sandbox
    const existing = this.sandboxes.get(sandboxId);
    if (existing) {
      existing.lastAccessed = new Date();
      return existing.provider;
    }

    // Try to reconnect to existing sandbox
    
    try {
      const provider = SandboxFactory.create();
      
      // For E2B provider, try to reconnect
      if (provider.constructor.name === 'E2BProvider') {
        // E2B sandboxes can be reconnected using the sandbox ID
        const reconnected = await (provider as any).reconnect(sandboxId);
        if (reconnected) {
          this.sandboxes.set(sandboxId, {
            sandboxId,
            provider,
            createdAt: new Date(),
            lastAccessed: new Date()
          });
          this.activeSandboxId = sandboxId;
          return provider;
        }
      }
      
      // For Vercel or if reconnection failed, return the new provider
      // The caller will need to handle creating a new sandbox
      return provider;
    } catch (error) {
      console.error(`[SandboxManager] Error reconnecting to sandbox ${sandboxId}:`, error);
      throw error;
    }
  }

  private getTimeoutMs(provider: SandboxProvider): number {
    const name = provider.constructor.name;
    if (name === 'E2BProvider') return appConfig.e2b.timeoutMs;
    if (name === 'VercelProvider') return appConfig.vercelSandbox.timeoutMs;
    return 0;
  }

  private emitTimeoutWarning(sandboxId: string, remainingMs: number): void {
    this.timeoutWarningCallbacks.forEach(cb => {
      try { cb(sandboxId, remainingMs); } catch (e) { console.error('Timeout warning callback error', e); }
    });
  }

  private scheduleWarning(sandboxId: string, timeoutMs: number): void {
    const warningTime = timeoutMs - this.warningThresholdMs;
    if (warningTime <= 0) return;
    const now = Date.now();
    const info = this.sandboxes.get(sandboxId);
    if (!info) return;
    const elapsed = now - info.createdAt.getTime();
    const remaining = timeoutMs - elapsed;
    const delay = remaining - this.warningThresholdMs;
    if (delay <= 0) {
      this.emitTimeoutWarning(sandboxId, Math.max(remaining, 0));
      return;
    }
    const watcher = setTimeout(() => {
      this.emitTimeoutWarning(sandboxId, this.warningThresholdMs);
    }, delay);
    this.timeoutWatchers.set(sandboxId, watcher);
  }

  private startTimeoutWatcher(sandboxId: string): void {
    const info = this.sandboxes.get(sandboxId);
    if (!info) return;
    const timeoutMs = this.getTimeoutMs(info.provider);
    if (!timeoutMs) return;
    this.scheduleWarning(sandboxId, timeoutMs);
  }

  /**
   * Register a new sandbox
   */
  registerSandbox(sandboxId: string, provider: SandboxProvider): void {
    this.sandboxes.set(sandboxId, {
      sandboxId,
      provider,
      createdAt: new Date(),
      lastAccessed: new Date()
    });
    this.activeSandboxId = sandboxId;
    this.startTimeoutWatcher(sandboxId);
  }

  /**
   * Get the active sandbox provider
   */
  getActiveProvider(): SandboxProvider | null {
    if (!this.activeSandboxId) {
      return null;
    }
    
    const sandbox = this.sandboxes.get(this.activeSandboxId);
    if (sandbox) {
      sandbox.lastAccessed = new Date();
      return sandbox.provider;
    }
    
    return null;
  }

  /**
   * Get a specific sandbox provider
   */
  getProvider(sandboxId: string): SandboxProvider | null {
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox) {
      sandbox.lastAccessed = new Date();
      return sandbox.provider;
    }
    return null;
  }

  /**
   * Set the active sandbox
   */
  setActiveSandbox(sandboxId: string): boolean {
    if (this.sandboxes.has(sandboxId)) {
      this.activeSandboxId = sandboxId;
      return true;
    }
    return false;
  }

  /**
   * Terminate a sandbox
   */
  async terminateSandbox(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox) {
      try {
        await sandbox.provider.terminate();
      } catch (error) {
        console.error(`[SandboxManager] Error terminating sandbox ${sandboxId}:`, error);
      }
      this.sandboxes.delete(sandboxId);
      // Clear timeout watcher if any
      const watcher = this.timeoutWatchers.get(sandboxId);
      if (watcher) {
        clearTimeout(watcher);
        this.timeoutWatchers.delete(sandboxId);
      }
      if (this.activeSandboxId === sandboxId) {
        this.activeSandboxId = null;
      }
    }
  }

  /**
   * Terminate all sandboxes
   */
  async terminateAll(): Promise<void> {
    const promises = Array.from(this.sandboxes.values()).map(sandbox =>
      sandbox.provider.terminate().catch(err =>
        console.error(`[SandboxManager] Error terminating sandbox ${sandbox.sandboxId}:`, err)
      )
    );
    await Promise.all(promises);
    this.sandboxes.clear();
    // Clear all watchers
    this.timeoutWatchers.forEach(watcher => clearTimeout(watcher));
    this.timeoutWatchers.clear();
    this.activeSandboxId = null;
  }

  /**
   * Clean up old sandboxes (older than maxAge milliseconds)
   */
  async cleanup(maxAge: number = 3600000): Promise<void> {
    // Also clear any timeout watchers for sandboxes being terminated

    const now = new Date();
    const toDelete: string[] = [];
    
    for (const [id, info] of this.sandboxes.entries()) {
      const age = now.getTime() - info.lastAccessed.getTime();
      if (age > maxAge) {
        toDelete.push(id);
      }
    }
    
    for (const id of toDelete) {
        await this.terminateSandbox(id);
      }
  }
}

// Export singleton instance
export const sandboxManager = new SandboxManager();

// Also maintain backward compatibility with global state
declare global {
  var sandboxManager: SandboxManager;
}

// Ensure the global reference points to our singleton
global.sandboxManager = sandboxManager;