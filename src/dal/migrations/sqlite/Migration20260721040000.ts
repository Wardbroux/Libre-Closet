import { Migration } from '@mikro-orm/migrations';

export class Migration20260721040000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'create table `garment_photo` (`id` integer not null primary key autoincrement, `garment_id` integer not null, `file_id` integer not null, `position` integer not null default 0, `created_on` text not null, constraint `garment_photo_garment_id_foreign` foreign key(`garment_id`) references `garment`(`id`) on update cascade on delete cascade, constraint `garment_photo_file_id_foreign` foreign key(`file_id`) references `file`(`id`) on update cascade on delete cascade);',
    );
    this.addSql(
      'create index `garment_photo_garment_id_index` on `garment_photo` (`garment_id`);',
    );
    this.addSql(
      'insert into `garment_photo` (`garment_id`, `file_id`, `position`, `created_on`) select `id`, `photo_id`, 0, datetime(\'now\') from `garment` where `photo_id` is not null;',
    );
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists `garment_photo`;');
  }
}
