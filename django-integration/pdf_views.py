import json
import uuid
import requests
import logging
from datetime import datetime

from django.http import JsonResponse, StreamingHttpResponse
from django.views.decorators.http import require_POST, require_GET
from django.views.decorators.csrf import csrf_exempt
from django.contrib.auth.decorators import login_required
from django.conf import settings

import redis

logger = logging.getLogger(__name__)

PDF_SERVICE_URL = getattr(settings, 'PDF_SERVICE_URL', 'http://localhost:3001')
PDF_SERVICE_API_KEY = getattr(settings, 'PDF_SERVICE_API_KEY', '')

PDF_SERVICE_HEADERS = {
    'Content-Type': 'application/json',
    'X-API-Key': PDF_SERVICE_API_KEY,
}


def serialize_purchase_order(po):
    return {
        "orderNumber": po.order_number,
        "status": po.get_status_display(),
        "orderDate": po.order_date.isoformat(),
        "deliveryDate": po.delivery_date.isoformat() if po.delivery_date else None,
        "paymentTerms": po.payment_terms,
        "currency": po.currency,
        "company": {
            "name": settings.COMPANY_NAME,
            "address": settings.COMPANY_ADDRESS,
            "gstin": settings.COMPANY_GSTIN,
            "pan": settings.COMPANY_PAN,
            "phone": settings.COMPANY_PHONE,
            "email": settings.COMPANY_EMAIL,
        },
        "vendor": {
            "name": po.vendor.name,
            "address": po.vendor.address,
            "gstin": po.vendor.gstin,
            "contact": po.vendor.contact_name,
        },
        "shipTo": {
            "name": po.ship_to_name,
            "address": po.ship_to_address,
            "city": po.ship_to_city,
            "state": po.ship_to_state,
            "pincode": po.ship_to_pincode,
        },
        "line_items": [
            {
                "name": item.product.name,
                "description": item.product.description,
                "hsnCode": item.product.hsn_code,
                "quantity": float(item.quantity),
                "unit": item.unit,
                "unitPrice": float(item.unit_price),
                "gstRate": float(item.gst_rate),
                "gstAmount": float(item.gst_amount),
                "totalAmount": float(item.total_amount),
            }
            for item in po.line_items.select_related('product').all()
        ],
        "totals": {
            "subtotal": float(po.subtotal),
            "cgst": float(po.cgst_total),
            "sgst": float(po.sgst_total),
            "igst": float(po.igst_total),
            "grandTotal": float(po.grand_total),
        },
        "terms": list(po.terms_and_conditions or []),
        "preparedBy": po.created_by.get_full_name(),
        "approvedBy": po.approved_by.get_full_name() if po.approved_by else "Pending",
    }


@login_required
@require_POST
def generate_single_pdf(request):
    try:
        body = json.loads(request.body)
        doc_type = body.get('type')
        document_id = body.get('document_id')

        if not doc_type or not document_id:
            return JsonResponse({'error': 'type and document_id are required'}, status=400)

        if doc_type == 'purchase_order':
            from .models import PurchaseOrder
            po = PurchaseOrder.objects.select_related(
                'vendor', 'created_by', 'approved_by'
            ).prefetch_related(
                'line_items__product'
            ).get(order_number=document_id)

            data = serialize_purchase_order(po)
        elif doc_type == 'invoice':
            from .models import Invoice
            invoice = Invoice.objects.get(invoice_number=document_id)
            data = serialize_invoice(invoice)
        else:
            return JsonResponse({'error': 'Invalid document type'}, status=400)

        response = requests.post(
            f'{PDF_SERVICE_URL}/api/pdf/generate',
            json={
                'type': doc_type,
                'documentId': document_id,
                'data': data,
            },
            headers=PDF_SERVICE_HEADERS,
            timeout=30,
        )

        if response.status_code == 200:
            result = response.json()
            return JsonResponse({
                'success': True,
                'download_url': result['downloadUrl'],
                'expires_at': result['expiresAt'],
                'file_size': result['fileSize'],
                'hmac_hash': result['hmacHash'],
            })
        else:
            logger.error(
                'PDF service returned error',
                extra={
                    'status_code': response.status_code,
                    'document_id': document_id,
                    'response': response.text,
                }
            )
            return JsonResponse(
                {'error': 'PDF generation failed', 'details': response.json()},
                status=response.status_code
            )

    except Exception as e:
        logger.exception(f'Failed to generate PDF for {document_id}')
        return JsonResponse({'error': str(e)}, status=500)


@login_required
@require_POST
def generate_bulk_pdf(request):
    try:
        body = json.loads(request.body)
        doc_type = body.get('type')
        document_ids = body.get('document_ids', [])

        if not document_ids:
            return JsonResponse({'error': 'document_ids is required'}, status=400)

        if len(document_ids) > 100:
            return JsonResponse({'error': 'Maximum 100 documents per bulk request'}, status=400)

        documents = []

        if doc_type == 'purchase_order':
            from .models import PurchaseOrder
            pos = PurchaseOrder.objects.select_related(
                'vendor', 'created_by', 'approved_by'
            ).prefetch_related(
                'line_items__product'
            ).filter(order_number__in=document_ids)

            po_map = {po.order_number: po for po in pos}

            for doc_id in document_ids:
                if doc_id not in po_map:
                    logger.warning(f'Purchase order {doc_id} not found, skipping')
                    continue

                documents.append({
                    'type': 'purchase_order',
                    'documentId': doc_id,
                    'data': serialize_purchase_order(po_map[doc_id]),
                })

        if not documents:
            return JsonResponse({'error': 'No valid documents found'}, status=400)

        response = requests.post(
            f'{PDF_SERVICE_URL}/api/pdf/bulk',
            json={'documents': documents},
            headers=PDF_SERVICE_HEADERS,
            timeout=10,
        )

        if response.status_code == 202:
            result = response.json()
            return JsonResponse({
                'success': True,
                'batch_id': result['batchId'],
                'document_count': result['documentCount'],
                'status_url': f'/api/pdf/bulk/status/{result["batchId"]}',
                'progress_url': f'/api/pdf/bulk/progress/{result["batchId"]}',
            }, status=202)
        else:
            return JsonResponse({'error': 'Failed to start bulk generation'}, status=500)

    except Exception as e:
        logger.exception('Failed to enqueue bulk PDF generation')
        return JsonResponse({'error': str(e)}, status=500)


@login_required
@require_GET
def bulk_pdf_progress(request, batch_id):
    def event_stream():
        r = redis.Redis(
            host=settings.REDIS_HOST,
            port=settings.REDIS_PORT,
            db=settings.REDIS_DB,
        )
        pubsub = r.pubsub()
        channel = f'pdf-svc:pdf-progress:{batch_id}'
        pubsub.subscribe(channel)

        yield 'data: {"type":"connected"}\n\n'

        event_id = 0
        for message in pubsub.listen():
            if message['type'] == 'message':
                event_id += 1
                data = message['data'].decode('utf-8')
                yield f'id: {event_id}\nevent: progress\ndata: {data}\n\n'

                parsed = json.loads(data)
                if parsed.get('status') in ('complete', 'partial_complete', 'failed'):
                    pubsub.unsubscribe(channel)
                    break

    response = StreamingHttpResponse(event_stream(), content_type='text/event-stream')
    response['Cache-Control'] = 'no-cache'
    response['X-Accel-Buffering'] = 'no'
    return response


@login_required
@require_GET
def get_download_url(request, document_id):
    try:
        response = requests.get(
            f'{PDF_SERVICE_URL}/api/pdf/download/{document_id}',
            headers=PDF_SERVICE_HEADERS,
            timeout=10,
        )

        if response.status_code == 200:
            result = response.json()
            return JsonResponse({
                'download_url': result['downloadUrl'],
                'expires_at': result['expiresAt'],
                'generated_at': result['generatedAt'],
            })
        elif response.status_code == 404:
            return JsonResponse({'error': 'Document not found'}, status=404)
        else:
            return JsonResponse({'error': 'Failed to get download URL'}, status=500)

    except Exception as e:
        logger.exception(f'Failed to get download URL for {document_id}')
        return JsonResponse({'error': str(e)}, status=500)


@login_required
@require_POST
def verify_pdf(request):
    try:
        body = json.loads(request.body)
        document_id = body.get('document_id')

        if not document_id:
            return JsonResponse({'error': 'document_id is required'}, status=400)

        response = requests.post(
            f'{PDF_SERVICE_URL}/api/pdf/verify',
            json={'documentId': document_id},
            headers=PDF_SERVICE_HEADERS,
            timeout=30,
        )

        result = response.json()
        return JsonResponse(result, status=response.status_code)

    except Exception as e:
        logger.exception(f'PDF verification failed for {document_id}')
        return JsonResponse({'error': str(e)}, status=500)
