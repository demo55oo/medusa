import { parse, toSeconds } from "iso8601-duration"
import { isEmpty, omit } from "lodash"
import { MedusaError } from "medusa-core-utils"
import { BaseService } from "medusa-interfaces"
import {
  Brackets,
  DeepPartial,
  EntityManager,
  ILike,
  SelectQueryBuilder,
} from "typeorm"
import {
  EventBusService,
  ProductService,
  RegionService,
  TotalsService,
} from "."
import { Cart } from "../models/cart"
import { Discount } from "../models/discount"
import {
  AllocationType as DiscountAllocation,
  DiscountRule,
  DiscountRuleType,
} from "../models/discount-rule"
import { LineItem } from "../models/line-item"
import { DiscountRepository } from "../repositories/discount"
import { DiscountConditionRepository } from "../repositories/discount-condition"
import { DiscountRuleRepository } from "../repositories/discount-rule"
import { GiftCardRepository } from "../repositories/gift-card"
import { FindConfig } from "../types/common"
import {
  CreateDiscountInput,
  CreateDiscountRuleInput,
  CreateDynamicDiscountInput,
  FilterableDiscountProps,
  UpdateDiscountInput,
  UpdateDiscountRuleInput,
} from "../types/discount"
import { isFuture, isPast } from "../utils/date-helpers"
import { formatException } from "../utils/exception-formatter"
import DiscountConditionService from "./discount-condition"

/**
 * Provides layer to manipulate discounts.
 * @implements {BaseService}
 */
class DiscountService extends BaseService {
  private manager_: EntityManager
  private discountRepository_: typeof DiscountRepository
  private discountRuleRepository_: typeof DiscountRuleRepository
  private giftCardRepository_: typeof GiftCardRepository
  private discountConditionRepository_: typeof DiscountConditionRepository
  private discountConditionService_: DiscountConditionService
  private totalsService_: TotalsService
  private productService_: ProductService
  private regionService_: RegionService
  private eventBus_: EventBusService

  constructor({
    manager,
    discountRepository,
    discountRuleRepository,
    giftCardRepository,
    discountConditionRepository,
    discountConditionService,
    totalsService,
    productService,
    regionService,
    customerService,
    eventBusService,
  }) {
    super()

    /** @private @const {EntityManager} */
    this.manager_ = manager

    /** @private @const {DiscountRepository} */
    this.discountRepository_ = discountRepository

    /** @private @const {DiscountRuleRepository} */
    this.discountRuleRepository_ = discountRuleRepository

    /** @private @const {GiftCardRepository} */
    this.giftCardRepository_ = giftCardRepository

    /** @private @const {DiscountConditionRepository} */
    this.discountConditionRepository_ = discountConditionRepository

    /** @private @const {DiscountConditionRepository} */
    this.discountConditionService_ = discountConditionService

    /** @private @const {TotalsService} */
    this.totalsService_ = totalsService

    /** @private @const {ProductService} */
    this.productService_ = productService

    /** @private @const {RegionService} */
    this.regionService_ = regionService

    /** @private @const {CustomerService} */
    this.customerService_ = customerService

    /** @private @const {EventBus} */
    this.eventBus_ = eventBusService
  }

  withTransaction(transactionManager: EntityManager): DiscountService {
    if (!transactionManager) {
      return this
    }

    const cloned = new DiscountService({
      manager: transactionManager,
      discountRepository: this.discountRepository_,
      discountRuleRepository: this.discountRuleRepository_,
      giftCardRepository: this.giftCardRepository_,
      discountConditionRepository: this.discountConditionRepository_,
      discountConditionService: this.discountConditionService_,
      totalsService: this.totalsService_,
      productService: this.productService_,
      regionService: this.regionService_,
      customerService: this.customerService_,
      eventBusService: this.eventBus_,
    })

    cloned.transactionManager_ = transactionManager
    cloned.manager_ = transactionManager

    return cloned
  }

  /**
   * Creates a discount rule with provided data given that the data is validated.
   * @param {DiscountRule} discountRule - the discount rule to create
   * @return {Promise} the result of the create operation
   */
  validateDiscountRule_<T extends { type: DiscountRuleType; value: number }>(
    discountRule: T
  ): T {
    if (discountRule.type === "percentage" && discountRule.value > 100) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Discount value above 100 is not allowed when type is percentage"
      )
    }

    return discountRule
  }

  /**
   * @param {Object} selector - the query object for find
   * @param {Object} config - the config object containing query settings
   * @return {Promise} the result of the find operation
   */
  async list(
    selector: FilterableDiscountProps = {},
    config: FindConfig<Discount> = { relations: [], skip: 0, take: 10 }
  ): Promise<Discount[]> {
    const discountRepo = this.manager_.getCustomRepository(
      this.discountRepository_
    )

    const query = this.buildQuery_(selector, config)
    return discountRepo.find(query)
  }

  /**
   * @param {Object} selector - the query object for find
   * @param {Object} config - the config object containing query settings
   * @return {Promise} the result of the find operation
   */
  async listAndCount(
    selector: FilterableDiscountProps = {},
    config: FindConfig<Discount> = {
      take: 20,
      skip: 0,
      order: { created_at: "DESC" },
    }
  ): Promise<[Discount[], number]> {
    const discountRepo = this.manager_.getCustomRepository(
      this.discountRepository_
    )

    let q
    if ("q" in selector) {
      q = selector.q
      delete selector.q
    }

    const query = this.buildQuery_(selector, config)

    if (q) {
      const where = query.where

      delete where.code

      query.where = (qb: SelectQueryBuilder<Discount>): void => {
        qb.where(where)

        qb.andWhere(
          new Brackets((qb) => {
            qb.where({ code: ILike(`%${q}%`) })
          })
        )
      }
    }

    const [discounts, count] = await discountRepo.findAndCount(query)

    return [discounts, count]
  }

  /**
   * Creates a discount with provided data given that the data is validated.
   * Normalizes discount code to uppercase.
   * @param {Discount} discount - the discount data to create
   * @return {Promise} the result of the create operation
   */
  async create(discount: CreateDiscountInput): Promise<Discount> {
    return this.atomicPhase_(async (manager: EntityManager) => {
      const discountRepo = manager.getCustomRepository(this.discountRepository_)
      const ruleRepo = manager.getCustomRepository(this.discountRuleRepository_)

      const conditions = discount.rule?.conditions

      const ruleToCreate = omit(discount.rule, ["conditions"])
      const validatedRule: Omit<CreateDiscountRuleInput, "conditions"> =
        this.validateDiscountRule_(ruleToCreate)

      if (
        discount?.regions &&
        discount?.regions.length > 1 &&
        discount?.rule?.type === "fixed"
      ) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Fixed discounts can have one region"
        )
      }
      try {
        if (discount.regions) {
          discount.regions = await Promise.all(
            discount.regions.map((regionId) =>
              this.regionService_.withTransaction(manager).retrieve(regionId)
            )
          )
        }

        const discountRule = ruleRepo.create(validatedRule)
        const createdDiscountRule = await ruleRepo.save(discountRule)

        discount.code = discount.code!.toUpperCase()

        const created: Discount = discountRepo.create(
          discount as DeepPartial<Discount>
        )
        created.rule = createdDiscountRule

        const result = await discountRepo.save(created)

        if (conditions?.length) {
          await Promise.all(
            conditions.map(async (cond) => {
              await this.discountConditionService_
                .withTransaction(manager)
                .upsertCondition({ rule_id: result.rule_id, ...cond })
            })
          )
        }

        return result
      } catch (error) {
        throw formatException(error)
      }
    })
  }

  /**
   * Gets a discount by id.
   * @param {string} discountId - id of discount to retrieve
   * @param {Object} config - the config object containing query settings
   * @return {Promise<Discount>} the discount
   */
  async retrieve(
    discountId: string,
    config: FindConfig<Discount> = {}
  ): Promise<Discount> {
    const discountRepo = this.manager_.getCustomRepository(
      this.discountRepository_
    )

    const validatedId = this.validateId_(discountId)
    const query = this.buildQuery_({ id: validatedId }, config)
    const discount = await discountRepo.findOne(query)

    if (!discount) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Discount with ${discountId} was not found`
      )
    }

    return discount
  }

  /**
   * Gets a discount by discount code.
   * @param {string} discountCode - discount code of discount to retrieve
   * @param {Object} config - the config object containing query settings
   * @return {Promise<Discount>} the discount document
   */
  async retrieveByCode(
    discountCode: string,
    config: FindConfig<Discount> = {}
  ): Promise<Discount> {
    const discountRepo = this.manager_.getCustomRepository(
      this.discountRepository_
    )

    let query = this.buildQuery_(
      { code: discountCode, is_dynamic: false },
      config
    )
    let discount = await discountRepo.findOne(query)

    if (!discount) {
      query = this.buildQuery_({ code: discountCode, is_dynamic: true }, config)
      discount = await discountRepo.findOne(query)

      if (!discount) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          `Discount with code ${discountCode} was not found`
        )
      }
    }

    return discount
  }

  /**
   * Updates a discount.
   * @param {string} discountId - discount id of discount to update
   * @param {Discount} update - the data to update the discount with
   * @return {Promise} the result of the update operation
   */
  async update(
    discountId: string,
    update: UpdateDiscountInput
  ): Promise<Discount> {
    return this.atomicPhase_(async (manager) => {
      const discountRepo: DiscountRepository = manager.getCustomRepository(
        this.discountRepository_
      )
      const ruleRepo: DiscountRuleRepository = manager.getCustomRepository(
        this.discountRuleRepository_
      )

      const discount = await this.retrieve(discountId, {
        relations: ["rule"],
      })

      const conditions = update?.rule?.conditions
      const ruleToUpdate = omit(update.rule, "conditions")

      if (!isEmpty(ruleToUpdate)) {
        update.rule = ruleToUpdate
      }

      const { rule, metadata, regions, ...rest } = update

      if (rest.ends_at) {
        if (discount.starts_at >= new Date(rest.ends_at)) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `"ends_at" must be greater than "starts_at"`
          )
        }
      }

      if (regions && regions?.length > 1 && discount.rule.type === "fixed") {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Fixed discounts can have one region"
        )
      }

      if (conditions?.length) {
        await Promise.all(
          conditions.map(async (cond) => {
            await this.discountConditionService_
              .withTransaction(manager)
              .upsertCondition({ rule_id: discount.rule_id, ...cond })
          })
        )
      }

      if (regions) {
        discount.regions = await Promise.all(
          regions.map((regionId) => this.regionService_.retrieve(regionId))
        )
      }

      if (metadata) {
        discount.metadata = await this.setMetadata_(discount.id, metadata)
      }

      if (rule) {
        const ruleUpdate: Omit<UpdateDiscountRuleInput, "conditions"> = rule

        if (rule.value) {
          this.validateDiscountRule_({
            value: rule.value,
            type: discount.rule.type,
          })
        }

        const updatedRule = ruleRepo.create({
          ...discount.rule,
          ...ruleUpdate,
        })

        discount.rule = updatedRule
      }

      for (const key of Object.keys(rest).filter(
        (k) => typeof rest[k] !== `undefined`
      )) {
        discount[key] = rest[key]
      }

      discount.code = discount.code.toUpperCase()

      const updated = await discountRepo.save(discount)
      return updated
    })
  }

  /**
   * Creates a dynamic code for a discount id.
   * @param {string} discountId - the id of the discount to create a code for
   * @param {Object} data - the object containing a code to identify the discount by
   * @return {Promise} the newly created dynamic code
   */
  async createDynamicCode(
    discountId: string,
    data: CreateDynamicDiscountInput
  ): Promise<Discount> {
    return this.atomicPhase_(async (manager) => {
      const discountRepo = manager.getCustomRepository(this.discountRepository_)

      const discount = await this.retrieve(discountId)

      if (!discount.is_dynamic) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Discount must be set to dynamic"
        )
      }

      if (!data.code) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Discount must have a code"
        )
      }

      const toCreate = {
        ...data,
        rule_id: discount.rule_id,
        is_dynamic: true,
        is_disabled: false,
        code: data.code.toUpperCase(),
        parent_discount_id: discount.id,
        usage_limit: discount.usage_limit,
      }

      if (discount.valid_duration) {
        const lastValidDate = new Date()
        lastValidDate.setSeconds(
          lastValidDate.getSeconds() + toSeconds(parse(discount.valid_duration))
        )
        toCreate.ends_at = lastValidDate
      }
      const created = await discountRepo.create(toCreate)
      const result = await discountRepo.save(created)
      return result
    })
  }

  /**
   * Deletes a dynamic code for a discount id.
   * @param {string} discountId - the id of the discount to create a code for
   * @param {string} code - the code to identify the discount by
   * @return {Promise} the newly created dynamic code
   */
  async deleteDynamicCode(discountId: string, code: string): Promise<void> {
    return this.atomicPhase_(async (manager) => {
      const discountRepo = manager.getCustomRepository(this.discountRepository_)
      const discount = await discountRepo.findOne({
        where: { parent_discount_id: discountId, code },
      })

      if (!discount) {
        return Promise.resolve()
      }

      await discountRepo.softRemove(discount)

      return Promise.resolve()
    })
  }

  /**
   * Adds a region to the discount regions array.
   * @param {string} discountId - id of discount
   * @param {string} regionId - id of region to add
   * @return {Promise} the result of the update operation
   */
  async addRegion(discountId: string, regionId: string): Promise<Discount> {
    return this.atomicPhase_(async (manager) => {
      const discountRepo = manager.getCustomRepository(this.discountRepository_)

      const discount = await this.retrieve(discountId, {
        relations: ["regions", "rule"],
      })

      const exists = discount.regions.find((r) => r.id === regionId)
      // If region is already present, we return early
      if (exists) {
        return discount
      }

      if (discount.regions?.length === 1 && discount.rule.type === "fixed") {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Fixed discounts can have one region"
        )
      }

      const region = await this.regionService_.retrieve(regionId)

      discount.regions = [...discount.regions, region]

      const updated = await discountRepo.save(discount)
      return updated
    })
  }

  /**
   * Removes a region from the discount regions array.
   * @param {string} discountId - id of discount
   * @param {string} regionId - id of region to remove
   * @return {Promise} the result of the update operation
   */
  async removeRegion(discountId: string, regionId: string): Promise<Discount> {
    return this.atomicPhase_(async (manager) => {
      const discountRepo = manager.getCustomRepository(this.discountRepository_)

      const discount = await this.retrieve(discountId, {
        relations: ["regions"],
      })

      const exists = discount.regions.find((r) => r.id === regionId)
      // If region is not present, we return early
      if (!exists) {
        return discount
      }

      discount.regions = discount.regions.filter((r) => r.id !== regionId)

      const updated = await discountRepo.save(discount)
      return updated
    })
  }

  /**
   * Deletes a discount idempotently
   * @param {string} discountId - id of discount to delete
   * @return {Promise} the result of the delete operation
   */
  async delete(discountId: string): Promise<void> {
    return this.atomicPhase_(async (manager) => {
      const discountRepo = manager.getCustomRepository(this.discountRepository_)

      const discount = await discountRepo.findOne({ where: { id: discountId } })

      if (!discount) {
        return Promise.resolve()
      }

      await discountRepo.softRemove(discount)

      return Promise.resolve()
    })
  }

  async validateDiscountForProduct(
    discountRuleId: string,
    productId: string | undefined
  ): Promise<boolean> {
    return this.atomicPhase_(async (manager) => {
      const discountConditionRepo: DiscountConditionRepository =
        manager.getCustomRepository(this.discountConditionRepository_)

      // In case of custom line items, we don't have a product id.
      // Instead of throwing, we simply invalidate the discount.
      if (!productId) {
        return false
      }

      const product = await this.productService_.retrieve(productId, {
        relations: ["tags"],
      })

      return await discountConditionRepo.isValidForProduct(
        discountRuleId,
        product.id
      )
    })
  }

  async calculateDiscountForLineItem(
    discountId: string,
    lineItem: LineItem,
    cart: Cart
  ): Promise<number> {
    let adjustment = 0

    if (!lineItem.allow_discounts) {
      return adjustment
    }

    const discount = await this.retrieve(discountId, { relations: ["rule"] })

    const { type, value, allocation } = discount.rule

    const fullItemPrice = lineItem.unit_price * lineItem.quantity

    if (type === DiscountRuleType.PERCENTAGE) {
      adjustment = Math.round((fullItemPrice / 100) * value)
    } else if (
      type === DiscountRuleType.FIXED &&
      allocation === DiscountAllocation.TOTAL
    ) {
      // when a fixed discount should be applied to the total,
      // we create line adjustments for each item with an amount
      // relative to the subtotal
      const subtotal = this.totalsService_.getSubtotal(cart, {
        excludeNonDiscounts: true,
      })
      const nominator = Math.min(value, subtotal)
      const itemRelativeToSubtotal = lineItem.unit_price / subtotal
      const totalItemPercentage = itemRelativeToSubtotal * lineItem.quantity
      adjustment = Math.round(nominator * totalItemPercentage)
    } else {
      adjustment = value * lineItem.quantity
    }
    // if the amount of the discount exceeds the total price of the item,
    // we return the total item price, else the fixed amount
    return adjustment >= fullItemPrice ? fullItemPrice : adjustment
  }

  async validateDiscountForCartOrThrow(
    cart: Cart,
    discount: Discount
  ): Promise<void> {
    if (this.hasReachedLimit(discount)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Discount has been used maximum allowed times"
      )
    }

    if (this.hasNotStarted(discount)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Discount is not valid yet"
      )
    }

    if (this.hasExpired(discount)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Discount is expired"
      )
    }

    if (this.isDisabled(discount)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "The discount code is disabled"
      )
    }

    const isValidForRegion = await this.isValidForRegion(
      discount,
      cart.region_id
    )
    if (!isValidForRegion) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "The discount is not available in current region"
      )
    }

    if (cart.customer_id) {
      const canApplyForCustomer = await this.canApplyForCustomer(
        discount.rule.id,
        cart.customer_id
      )

      if (!canApplyForCustomer) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Discount is not valid for customer"
        )
      }
    }
  }

  hasReachedLimit(discount: Discount): boolean {
    const count = discount.usage_count || 0
    const limit = discount.usage_limit
    return !!limit && count >= limit
  }

  hasNotStarted(discount: Discount): boolean {
    return isFuture(discount.starts_at)
  }

  hasExpired(discount: Discount): boolean {
    if (!discount.ends_at) {
      return false
    }

    return isPast(discount.ends_at)
  }

  isDisabled(discount: Discount): boolean {
    return discount.is_disabled
  }

  async isValidForRegion(
    discount: Discount,
    region_id: string
  ): Promise<boolean> {
    let regions = discount.regions

    if (discount.parent_discount_id) {
      const parent = await this.retrieve(discount.parent_discount_id, {
        relations: ["rule", "regions"],
      })

      regions = parent.regions
    }

    return regions.find(({ id }) => id === region_id) !== undefined
  }

  async canApplyForCustomer(
    discountRuleId: string,
    customerId: string | undefined
  ): Promise<boolean> {
    return this.atomicPhase_(async (manager) => {
      const discountConditionRepo: DiscountConditionRepository =
        manager.getCustomRepository(this.discountConditionRepository_)

      // Instead of throwing on missing customer id, we simply invalidate the discount
      if (!customerId) {
        return false
      }

      const customer = await this.customerService_.retrieve(customerId, {
        relations: ["groups"],
      })

      return await discountConditionRepo.canApplyForCustomer(
        discountRuleId,
        customer.id
      )
    })
  }
}

export default DiscountService
