import {
  Entity,
  ManyToOne,
  PrimaryKey,
  Property,
  type Ref,
} from '@mikro-orm/core';
import { File } from './file.entity';
import { Garment } from './garment.entity';

@Entity()
export class GarmentPhoto {
  @PrimaryKey()
  public id!: number;

  @ManyToOne({
    entity: () => Garment,
    deleteRule: 'cascade',
    ref: true,
  })
  public garment!: Ref<Garment>;

  @ManyToOne({
    entity: () => File,
    deleteRule: 'cascade',
    ref: true,
  })
  public file!: Ref<File>;

  @Property({ default: 0 })
  public position = 0;

  @Property()
  public createdOn!: string;
}
