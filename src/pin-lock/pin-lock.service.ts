import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import { createHmac, randomBytes } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

type PinLockConfig = {
  pinHash: string;
  tokenSecret: string;
  updatedAt: string;
};

@Injectable()
export class PinLockService {
  private cachedConfig: PinLockConfig | null | undefined;

  constructor(private readonly configService: ConfigService) {}

  private configPath(): string {
    return join(
      this.configService.getOrThrow<string>('DATA_PATH'),
      'pin-lock.json',
    );
  }

  private async readConfig(): Promise<PinLockConfig | null> {
    if (this.cachedConfig !== undefined) return this.cachedConfig;
    try {
      const raw = await readFile(this.configPath(), 'utf8');
      this.cachedConfig = JSON.parse(raw) as PinLockConfig;
    } catch {
      this.cachedConfig = null;
    }
    return this.cachedConfig;
  }

  async isConfigured(): Promise<boolean> {
    return (await this.readConfig()) != null;
  }

  async verifyPin(pin: string): Promise<boolean> {
    const config = await this.readConfig();
    if (!config) return false;
    return bcrypt.compare(pin, config.pinHash);
  }

  async setPin(pin: string): Promise<void> {
    const config: PinLockConfig = {
      pinHash: await bcrypt.hash(pin, 12),
      tokenSecret: randomBytes(32).toString('hex'),
      updatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(this.configPath()), { recursive: true });
    await writeFile(this.configPath(), JSON.stringify(config, null, 2), 'utf8');
    this.cachedConfig = config;
  }

  async unlockToken(): Promise<string> {
    const config = await this.readConfig();
    if (!config) return '';
    return createHmac('sha256', config.tokenSecret)
      .update(config.pinHash)
      .digest('hex');
  }

  async isUnlocked(token: string | undefined): Promise<boolean> {
    if (!(await this.isConfigured())) return true;
    if (!token) return false;
    return token === (await this.unlockToken());
  }
}
