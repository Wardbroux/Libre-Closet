import { Migration } from '@mikro-orm/migrations';

export class Migration20260721010000 extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table "garment" add column "location" text null;');
    this.addSql('alter table "garment" add column "tags" text null;');
  }

  override async down(): Promise<void> {
    this.addSql('alter table "garment" drop column "location";');
    this.addSql('alter table "garment" drop column "tags";');
  }
}
