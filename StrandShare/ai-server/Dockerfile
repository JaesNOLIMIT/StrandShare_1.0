# syntax=docker/dockerfile:1.6
#
# Wig Catalog Studio - local AI server image.
#
# Base: CUDA 11.8 + cuDNN 8 + Ubuntu 22.04. Matches the torch==2.4.1 cu118
# wheel pinned in requirements.txt. Builds on a developer machine with an
# RTX 3050 Laptop (4 GB VRAM).

FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models/huggingface \
    TORCH_HOME=/models/torch \
    U2NET_HOME=/models/u2net

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 \
        python3.10-venv \
        python3-pip \
        git \
        wget \
        ca-certificates \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN update-alternatives --install /usr/bin/python python /usr/bin/python3.10 1 \
 && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.10 1

WORKDIR /app

COPY requirements.txt /app/requirements.txt

# Install torch from the cu118 index first so the rest of pip resolves
# against the GPU wheel instead of dragging in a CPU build.
RUN pip install --upgrade pip \
 && pip install --index-url https://download.pytorch.org/whl/cu118 \
        torch==2.4.1 torchvision==0.19.1 \
 && pip install -r /app/requirements.txt

# Pre-create model cache dirs so the volume mount has the right owner.
RUN mkdir -p /models/huggingface /models/torch /models/u2net

COPY app /app/app

EXPOSE 8000

# Single worker - the model is loaded into one GPU context.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
