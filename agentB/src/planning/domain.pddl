(define (domain deliveroo)
  (:requirements :strips :typing :negative-preconditions)

  (:types
    location parcel agent - object
  )

  (:predicates
    (at ?a - agent ?l - location)
    (parcel-at ?p - parcel ?l - location)
    (holding ?a - agent ?p - parcel)
    (delivered ?p - parcel)
    (delivery-tile ?l - location)
    (connected ?from - location ?to - location)
    (forbidden-pickup ?l - location)
    (forbidden-delivery ?l - location)
    (zero-reward-delivery ?l - location)
    (parcel-reserved ?p - parcel)
    (carry-count-0 ?a - agent)
    (carry-count-1 ?a - agent)
    (carry-count-2 ?a - agent)
    (carry-count-3 ?a - agent)
  )

  ;; ── Move between adjacent tiles ──────────────────────────────────────────
  (:action move
    :parameters (?a - agent ?from - location ?to - location)
    :precondition (and
      (at ?a ?from)
      (connected ?from ?to)
    )
    :effect (and
      (not (at ?a ?from))
      (at ?a ?to)
    )
  )

  ;; ── Pickup a parcel (max carry = 3 encoded via counter predicates) ────────
  (:action pickup
    :parameters (?a - agent ?p - parcel ?l - location)
    :precondition (and
      (at ?a ?l)
      (parcel-at ?p ?l)
      (not (holding ?a ?p))
      (not (forbidden-pickup ?l))
      (not (parcel-reserved ?p))
      (carry-count-0 ?a)          ; only pick up when carrying 0 (extend as needed)
    )
    :effect (and
      (holding ?a ?p)
      (not (parcel-at ?p ?l))
      (not (carry-count-0 ?a))
      (carry-count-1 ?a)
    )
  )

  (:action pickup-1
    :parameters (?a - agent ?p - parcel ?l - location)
    :precondition (and
      (at ?a ?l)
      (parcel-at ?p ?l)
      (not (holding ?a ?p))
      (not (forbidden-pickup ?l))
      (not (parcel-reserved ?p))
      (carry-count-1 ?a)
    )
    :effect (and
      (holding ?a ?p)
      (not (parcel-at ?p ?l))
      (not (carry-count-1 ?a))
      (carry-count-2 ?a)
    )
  )

  (:action pickup-2
    :parameters (?a - agent ?p - parcel ?l - location)
    :precondition (and
      (at ?a ?l)
      (parcel-at ?p ?l)
      (not (holding ?a ?p))
      (not (forbidden-pickup ?l))
      (not (parcel-reserved ?p))
      (carry-count-2 ?a)
    )
    :effect (and
      (holding ?a ?p)
      (not (parcel-at ?p ?l))
      (not (carry-count-2 ?a))
      (carry-count-3 ?a)
    )
  )

  ;; ── Deliver parcels on a delivery tile ────────────────────────────────────
  (:action deliver
    :parameters (?a - agent ?p - parcel ?l - location)
    :precondition (and
      (at ?a ?l)
      (holding ?a ?p)
      (delivery-tile ?l)
      (not (forbidden-delivery ?l))
      (not (zero-reward-delivery ?l))
    )
    :effect (and
      (not (holding ?a ?p))
      (delivered ?p)
    )
  )
)