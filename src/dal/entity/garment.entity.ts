import {
  Collection,
  Entity,
  Enum,
  ManyToMany,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryKey,
  Property,
  type Ref,
} from '@mikro-orm/core';
import { File } from './file.entity';
import { GarmentPhoto } from './garment-photo.entity';
import { Outfit } from './outfit.entity';
import { ShareableId } from './shareableId.entity';
import { User } from './user.entity';
import { GarmentColor } from '../../wardrobe/garment-color.enum';

export { GarmentColor };

@Entity()
export class Garment extends ShareableId {
  @PrimaryKey()
  public id!: number;

  @Property({ nullable: true })
  public name?: string;

  @Property()
  public category!: string;

  @Enum({ nullable: true })
  public color?: GarmentColor;

  @Property({ nullable: true })
  public brand?: string;

  @Property({ nullable: true })
  public size?: string;

  @Property({ nullable: true })
  public location?: string;

  @Property({ nullable: true, columnType: 'text' })
  public tags?: string;

  @Property({ type: Date, nullable: true })
  public dateAquired?: Date;

  @Property({ nullable: true })
  public notes?: string;

  @Property({ default: false })
  public archived = false;
  @Property({ nullable: true, columnType: 'text' })
  public washingDetails?: string;

  @OneToOne({
    entity: () => File,
    nullable: true,
  })
  public photo?: Ref<File>;

  @OneToMany(() => GarmentPhoto, (photo) => photo.garment, {
    orderBy: { position: 'ASC', id: 'ASC' },
  })
  public photos = new Collection<GarmentPhoto>(this);

  @ManyToOne({
    entity: () => User,
    deleteRule: 'cascade',
    ref: true,
    nullable: true,
  })
  public owner?: Ref<User>;

  @ManyToMany(() => Outfit, (outfit) => outfit.garments)
  public outfits = new Collection<Outfit>(this);
}
